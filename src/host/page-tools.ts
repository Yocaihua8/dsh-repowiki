import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RepositorySnapshot } from './snapshot.js'
import type { SourceExcerpt } from '../shared/types.js'

const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value) ?? 'null').digest('hex')
const short = z.string().trim().min(1).max(500)
const sourceId = z.string().regex(/^[a-f0-9]{32}$/)
const evidence = z.object({ sourceId, path: short, startLine: z.number().int().positive(), endLine: z.number().int().positive(), quote: z.string().min(1).max(6000) })
const claim = z.object({ claim: short, evidence: z.array(evidence).min(1) })
const claimList = z.array(claim).min(1)
export function parseJsonArray(value: string): unknown {
  try { return JSON.parse(value) } catch { /* Repair unescaped quotes from tool-calling models. */ }
  let repaired = '', inString = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (inString && ch === '\\') { repaired += ch + (value[++i] ?? ''); continue }
    if (ch !== '"') { repaired += ch; continue }
    if (!inString) { inString = true; repaired += ch; continue }
    let next = i + 1
    while (next < value.length && /\s/.test(value[next]!)) next++
    if (next === value.length || [':', ',', '}', ']'].includes(value[next]!)) { inString = false; repaired += ch }
    else repaired += '\\"'
  }
  try { return JSON.parse(repaired) } catch { throw new Error('参数必须是数组，或包含数组的 JSON 字符串。') }
}
const jsonArray = <T extends z.ZodType>(schema: z.ZodArray<T>) => z.union([schema, z.string().min(1).transform(value => schema.parse(parseJsonArray(value)))])
const claimsInput = jsonArray(claimList)
const verificationEvidence = z.object({ sourceId, path: short, startLine: z.number().int().positive(), endLine: z.number().int().positive() })
const verificationClaim = z.object({ claim: short, evidence: z.array(verificationEvidence).min(1) })
const verificationClaimsInput = jsonArray(z.array(verificationClaim).min(1))
const reviewInput = z.object({
  pass: z.boolean(),
  plainLanguage: z.boolean().nullable().optional(),
  relevance: z.boolean().nullable(),
  structure: z.boolean().nullable(),
  citations: z.boolean(),
  issues: z.array(short).max(8),
})
const evidenceInput = jsonArray(z.array(evidence).min(1))
const cardInput = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(), title: short, category: z.enum(['architecture', 'workflow', 'api', 'testing', 'constraints']), summary: short, content: z.string().min(1).max(8000), evidence: evidenceInput })
const output = { schema: { type: 'object' as const, additionalProperties: true }, render: (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const tool = <T extends z.ZodType>(name: string, description: string, schema: T, action: (args: z.infer<T>, exec: { concludeTurn(): void }) => unknown | Promise<unknown>): ToolDefinition => ({
  name, description, parameters: z.toJSONSchema(schema, { io: 'input' }) as ToolDefinition['parameters'], output,
  execute: async (raw, exec) => action(schema.parse(raw), exec),
})

export interface PageSubmitInput {
  content: string
  sources: SourceExcerpt[]
  sourceIds?: string[]
  card?: { id?: string; title: string; category: string; summary: string; content: string; evidence: { sourceId: string; path: string; startLine: number; endLine: number; quote: string }[] }
  limitations?: string[]
}
export interface VerificationSubmitInput {
  kind: 'page' | 'card'
  id: string
  supported: boolean
  issues: string[]
  claims: { claim: string; evidence: { sourceId: string; path: string; startLine: number; endLine: number }[] }[]
  review?: ReviewSubmitInput
}
export interface ReviewSubmitInput {
  pass: boolean
  plainLanguage?: boolean | null
  relevance: boolean | null
  structure: boolean | null
  citations: boolean
  issues: string[]
}

/** Read-only snapshot tools for one page worker. Reads stay local until submit. */
export function snapshotTools(snapshot: RepositorySnapshot, reads: Map<string, SourceExcerpt>): ToolDefinition[] {
  return [
    tool('wiki_files', '列出项目只读快照中的文件与行数，分页返回。', z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(60) }), a => {
      const files = snapshot.files.map(file => ({ path: file.path, lines: file.text.split('\n').length }))
      return { total: files.length, files: files.slice(a.offset, a.offset + a.limit), next: a.offset + a.limit < files.length ? a.offset + a.limit : null }
    }),
    tool('wiki_search', '在项目只读快照中搜索文字（非正则），分页返回路径和行号；用 wiki_read 获取原文。', z.object({ query: short, prefix: z.string().default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }), a => {
      const matches = snapshot.files.filter(file => file.path.startsWith(a.prefix)).flatMap(file => file.text.split('\n').flatMap((line, index) => line.toLowerCase().includes(a.query.toLowerCase()) ? [{ path: file.path, line: index + 1, text: line.slice(0, 500) }] : []))
      return { total: matches.length, matches: matches.slice(a.offset, a.offset + a.limit), next: a.offset + a.limit < matches.length ? a.offset + a.limit : null }
    }),
    tool('wiki_read', '按行读取不可变源码，返回 sourceId、总行数与下一页；没有读取的部分不能视为已分析。', z.object({ path: short, startLine: z.number().int().positive().default(1), lines: z.number().int().positive().max(250).default(160) }), a => {
      const file = snapshot.files.find(candidate => candidate.path === a.path)
      if (!file) throw new Error('路径不在项目只读快照中。')
      const all = file.text.split('\n')
      if (a.startLine > all.length) throw new Error('起始行超出文件范围。')
      const selected: string[] = []; let bytes = 0
      for (const line of all.slice(a.startLine - 1, a.startLine - 1 + a.lines)) { if (bytes + Buffer.byteLength(line) > 48 * 1024) break; selected.push(line); bytes += Buffer.byteLength(line) + 1 }
      if (!selected.length) throw new Error('单行超过安全读取范围。')
      const text = selected.join('\n'), endLine = a.startLine + selected.length - 1
      const source: SourceExcerpt = { ...file, id: digest([file.version, file.path, a.startLine, endLine, text]).slice(0, 32), startLine: a.startLine, endLine, text, hash: digest(text) }
      reads.set(source.id, source)
      return { sourceId: source.id, path: file.path, version: file.version, startLine: a.startLine, endLine, totalLines: all.length, nextLine: endLine < all.length ? endLine + 1 : null, lines: selected.map((text, index) => ({ line: a.startLine + index, text })) }
    }),
  ]
}

/** One page worker can submit a page and an optional card; the Host validates and commits. */
export function pageSubmitTool(pageId: string, reads: Map<string, SourceExcerpt>, submit: (input: PageSubmitInput) => Promise<{ done: true; warnings?: string[] }>): ToolDefinition {
  let submitted = false
  return tool('submit_page', '提交本页 Markdown、来源与可选卡片。Host 会校验引用、来源和深度；被退回时按错误补读/补写后重交。', z.object({ content: z.string().trim().min(1), sourceIds: z.array(sourceId).optional(), card: cardInput.optional(), limitations: z.array(short).max(8).optional() }), async (a, exec) => {
    if (submitted) throw new Error('本页已提交；如需修改请等待 Host 退回。')
    const result = await submit({ content: a.content, sources: [...reads.values()], sourceIds: a.sourceIds, card: a.card ? { ...a.card, evidence: a.card.evidence } : undefined, limitations: a.limitations })
    submitted = true; exec.concludeTurn(); return result
  })
}

/** Verifier submits claims for the Host-fixed page or card. */
export function verificationTool(kind: 'page' | 'card', id: string, submit: (input: VerificationSubmitInput) => Promise<{ done: true; review?: VerificationSubmitInput['review'] }>): ToolDefinition {
  let submitted = false
  return tool('submit_verification', '提交本页/卡片的关键结论、支持状态与源码行号，并单独提交可读性审阅 review；Host 会按行号提取原文并校验成果版本。evidence 不需要 quote。', z.object({ supported: z.boolean(), issues: z.array(short), claims: verificationClaimsInput, review: reviewInput.optional() }), async (a, exec) => {
    if (submitted) throw new Error('核验已提交。')
    const result = await submit({ kind, id, supported: a.supported, issues: a.issues, claims: a.claims, review: a.review })
    submitted = true; exec.concludeTurn(); return result
  })
}

/** Lightweight semantic readability reviewer submits only the review result (no source reads). */
export function reviewSubmitTool(id: string, submit: (input: ReviewSubmitInput) => Promise<{ done: true; review: ReviewSubmitInput }>): ToolDefinition {
  let submitted = false
  return tool('submit_review', '提交本页的可读性与人话表达审阅结果（pass/plainLanguage/relevance/structure/citations/issues）。', reviewInput, async (a, exec) => {
    if (submitted) throw new Error('审阅已提交。')
    const result = await submit(a)
    submitted = true; exec.concludeTurn(); return result
  })
}
