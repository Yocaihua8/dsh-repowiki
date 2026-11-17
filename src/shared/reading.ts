import type { ReadingPaths } from './types.js'
export type ReadingRoute = 'all' | keyof ReadingPaths
export function validateReadingPlan(plan: { pages: { id: string; title: string; kind?: string; parentId?: string | null; relatedPageIds?: string[] }[]; readingPaths?: ReadingPaths }): void {
  const pages = new Set(plan.pages.filter(p => p.kind !== 'group').map(p => p.id))
  const titles = new Set<string>()
  for (const p of plan.pages) {
    const key = `${p.parentId ?? ''}:${p.title.trim().toLocaleLowerCase()}`
    if (titles.has(key)) throw new Error(`同级标题重复：${p.title}`)
    titles.add(key)
    if (p.relatedPageIds && (!Array.isArray(p.relatedPageIds) || p.relatedPageIds.some(id => id === p.id || !pages.has(id)))) throw new Error(`无效关联页面：${p.id}`)
  }
  if (plan.readingPaths !== undefined) {
    for (const key of ['user', 'developer', 'maintainer'] as const) {
      const ids = plan.readingPaths?.[key]
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !pages.has(id)) || new Set(ids).size !== ids.length) throw new Error(`阅读路线 ${key} 包含无效页面或重复项`)
    }
  }
}
export function routePages<T extends { id: string; kind?: string; bytes: number }>(pages: T[], paths: ReadingPaths | undefined, route: ReadingRoute): T[] {
  const readable = pages.filter(p => p.kind !== 'group' && p.bytes > 0)
  return route === 'all' ? readable : (paths?.[route] ?? []).flatMap(id => { const p = readable.find(p => p.id === id); return p ? [p] : [] })
}
export function diagramZoom(value: number): number { return Math.max(0.5, Math.min(2, Number.isFinite(value) ? value : 1)) }
