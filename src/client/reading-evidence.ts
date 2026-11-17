/** Display labels never replace the source identity used for RPC or exports. */
export function sourceLabel(path: string, paths: readonly string[]): string {
  const parts = path.replace(/\\/g, '/').split('/')
  for (let width = 1; width <= parts.length; width++) {
    const label = parts.slice(-width).join('/')
    if (!paths.some(other => other !== path && other.replace(/\\/g, '/').split('/').slice(-width).join('/') === label)) return label
  }
  return path
}

export function citedFiles<T extends { id: string; path: string; startLine: number; endLine: number }>(body: string, sources: readonly T[]): T[] {
  // Ignore fenced examples: a quoted citation is not necessarily a page reference.
  const prose = body.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
  const files = new Map<string, T>()
  for (const match of prose.matchAll(/`([^`\n]+):L?(\d+)(?:-L?(\d+))?`/g)) {
    const path = match[1]!.replace(/\\/g, '/').replace(/^\.\//, '')
    const start = Number(match[2]), end = Number(match[3] ?? match[2])
    const source = sources.find(s => s.path === path && s.startLine <= start && s.endLine >= end)
    if (source && !files.has(path)) files.set(path, source)
  }
  return [...files.values()]
}

/** Host Markdown renders the inline-code value, not its accessible label. */
export function readingCitations(body: string, paths: readonly string[]): { text: string; originals: Map<string, string> } {
  const originals = new Map<string, string>()
  let fence: { marker: string; length: number } | undefined
  const text = body.split('\n').map(line => {
    const boundary = line.match(/^\s*(`{3,}|~{3,})/)
    if (boundary) {
      const marker = boundary[1]!
      if (!fence) fence = { marker: marker[0]!, length: marker.length }
      else if (marker[0] === fence.marker && marker.length >= fence.length && !line.slice(boundary[0].length).trim()) fence = undefined
      return line
    }
    if (fence) return line
    return line.replace(/`([^`\n]+)(:L?\d+(?:-L?\d+)?)`/g, (token, path: string, range: string) => {
      if (!paths.includes(path)) return token
      const label = sourceLabel(path, paths) + range
      originals.set(label, path + range)
      return '`' + label + '`'
    })
  }).join('\n')
  return { text, originals }
}
