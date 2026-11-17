/**
 * 项目总览数据：工作区目录 ∪ 已生成维基的仓库路径。
 *
 * 工作区来自宿主 workspaceRegistry（当前打开的项目）；维基来自插件存储。
 * 两边按归一化路径去重合并——真实实现中这就是初始页卡片列表的数据源。
 */
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ProjectEntry, WikiManifest, WikiSummary } from '../shared/types.js'
import { listWikis } from './store.js'

function normalizePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function summarize(manifest: WikiManifest): WikiSummary {
  return {
    id: manifest.id,
    title: manifest.title,
    pages: manifest.pages.filter(p => p.kind !== 'group').length,
    cards: manifest.cards?.length ?? 0,
    refs: manifest.pages.reduce((sum, page) => sum + page.related.length, 0),
    updatedAt: manifest.updatedAt,
  }
}

export async function listProjects(ctx: Pick<Context, 'get'>, stateDir: string, signal: AbortSignal): Promise<ProjectEntry[]> {
  signal.throwIfAborted()
  const manifests = await listWikis(stateDir).catch(() => [] as WikiManifest[])
  const wikiByPath = new Map<string, WikiSummary>()
  const pathById = new Map<string, string>()
  for (const manifest of manifests) {
    if (typeof manifest.repoPath !== 'string' || manifest.repoPath.trim() === '') continue
    const normalized = normalizePath(manifest.repoPath)
    wikiByPath.set(normalized, summarize(manifest))
    pathById.set(manifest.id, manifest.repoPath)
  }

  const projects: ProjectEntry[] = []
  const seen = new Set<string>()
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  if (registry && typeof registry.list === 'function') {
    for (const workspace of registry.list()) {
      signal.throwIfAborted()
      if (typeof workspace?.path !== 'string' || workspace.path.trim() === '') continue
      const normalized = normalizePath(workspace.path)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      projects.push({ name: workspace.title || basename(workspace.path), path: workspace.path, wiki: wikiByPath.get(normalized) ?? null })
    }
  }
  // 仅在维基存储中存在、不在当前工作区列表里的仓库（历史生成）。
  for (const [normalized, wiki] of wikiByPath) {
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const path = pathById.get(wiki.id) ?? ''
    projects.push({ name: basename(path) || wiki.title, path, wiki })
  }
  return projects
}
