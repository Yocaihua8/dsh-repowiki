import type { SourceExcerpt } from '../shared/types.js'

export interface Citation {
  token: string
  path: string
  startLine: number
  endLine: number
  start?: number
  end?: number
}

export interface ParseCitationOptions {
  /** Enables bare path:line citations; only these paths are recognized. */
  paths?: Iterable<string>
  allowBare?: boolean
}

const PATH = '[A-Za-z0-9_./@-]+?'
const CITATION = new RegExp(`${PATH}(?::\\s*L?(\\d+)(?:\\s*[-–]\\s*L?(\\d+))?|#L(\\d+)(?:\\s*[-–]\\s*L?(\\d+))?)`, 'g')

function readCitation(match: RegExpMatchArray): { path: string; startLine: number; endLine: number } | null {
  const path = match[0].slice(0, match[0].search(/[:#]/))
  if (!path || path.includes('//') || /^[a-z]+:\/\//i.test(path)) return null
  const start = Number(match[1] ?? match[3])
  const end = Number(match[2] ?? match[4] ?? start)
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) return null
  return { path, startLine: start, endLine: end }
}

/** Line ranges covered by a code fence are not prose citations. */
function fencedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let offset = 0, open: number | undefined
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (open === undefined) open = offset
      else { ranges.push([open, offset + line.length]); open = undefined }
    }
    offset += line.length + 1
  }
  if (open !== undefined) ranges.push([open, content.length])
  return ranges
}

const inside = (position: number, ranges: Array<[number, number]>) => ranges.some(([start, end]) => position >= start && position < end)

/**
 * Parse canonical `path:L1-L9`, `path:1-9`, `path#L1-L9` and comma-separated
 * groups in one inline-code span. Bare citations are opt-in and snapshot-aware,
 * so code examples and unknown paths cannot silently become evidence.
 */
export function parseCitations(content: string, options: ParseCitationOptions = {}): Citation[] {
  const citations: Citation[] = []
  const spans: Array<[number, number]> = []
  for (const match of content.matchAll(/`([^`\n]+)`/g)) {
    const start = match.index!, end = start + match[0].length
    spans.push([start, end])
    for (const inner of match[1]!.matchAll(CITATION)) {
      const read = readCitation(inner)
      if (!read) continue
      citations.push({ token: match[0], path: read.path, startLine: read.startLine, endLine: read.endLine, start, end })
    }
  }
  if (!options.allowBare) return citations.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  const known = new Set(options.paths ?? [])
  const fences = fencedRanges(content)
  for (const match of content.matchAll(CITATION)) {
    const read = readCitation(match)
    if (!read || !known.has(read.path)) continue
    const start = match.index!, end = start + match[0].length
    if (inside(start, spans) || inside(start, fences)) continue
    citations.push({ token: match[0], path: read.path, startLine: read.startLine, endLine: read.endLine, start, end })
  }
  return citations.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
}

/** Bare path:line tokens that look like citations but do not match a snapshot file. */
export function suspiciousCitations(content: string, paths: Iterable<string>): string[] {
  const known = new Set(paths)
  const spans: Array<[number, number]> = []
  for (const match of content.matchAll(/`([^`\n]+)`/g)) spans.push([match.index!, match.index! + match[0].length])
  const fences = fencedRanges(content)
  const found = new Set<string>()
  for (const match of content.matchAll(CITATION)) {
    const read = readCitation(match)
    if (!read || known.has(read.path) || !(read.path.includes('/') || read.path.includes('.'))) continue
    const start = match.index!
    if (inside(start, spans) || inside(start, fences)) continue
    found.add(match[0])
  }
  return [...found].slice(0, 8)
}

function mergeSpans(sources: SourceExcerpt[]): Array<{ startLine: number; endLine: number }> {
  const out: Array<{ startLine: number; endLine: number }> = []
  for (const source of [...sources].sort((a, b) => a.startLine - b.startLine)) {
    const last = out.at(-1)
    if (last && source.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, source.endLine)
    else out.push({ startLine: source.startLine, endLine: source.endLine })
  }
  return out
}

function covered(sources: SourceExcerpt[], startLine: number, endLine: number): boolean {
  return mergeSpans(sources).some(span => span.startLine <= startLine && span.endLine >= endLine)
}

/** Mark unsupported model-authored line citations instead of presenting them as verified evidence. */
export function markUnverifiedCitations(content: string, sources: SourceExcerpt[], language: string, paths?: Iterable<string>): string {
  const known = paths ?? sources.map(source => source.path)
  const citations = parseCitations(content, { paths: known, allowBare: true })
  const groups = new Map<string, Citation[]>()
  for (const citation of citations) {
    if (citation.start === undefined || citation.end === undefined) continue
    const key = `${citation.start}:${citation.end}`
    groups.set(key, [...(groups.get(key) ?? []), citation])
  }
  const replacements = [...groups.values()].map(group => {
    const unverified = group.some(citation => !covered(sources.filter(source => source.path === citation.path), citation.startLine, citation.endLine))
    return unverified ? { start: group[0]!.start!, end: group[0]!.end!, text: content.slice(group[0]!.start!, group[0]!.end!) } : undefined
  }).filter((replacement): replacement is { start: number; end: number; text: string } => !!replacement)
    .sort((a, b) => b.start - a.start)
  let result = content
  const marker = language === 'en' ? '(unverified reference)' : '（引用未核实）'
  for (const replacement of replacements) result = `${result.slice(0, replacement.start)}${replacement.text} ${marker}${result.slice(replacement.end)}`
  return result
}
