/**
 * 维基存储 — `$DSH_HOME/dsh-repowiki/wikis/<wikiId>/`。
 *
 * - manifest.json: 维基元信息与页面目录；
 * - revisions/<revision>/pages/<pageId>.md: 每页一篇 Markdown；sources 保存只读引用。
 *
 * 同一仓库路径的 wikiId 固定，新版本完整写入后原子切换清单；旧 pages 路径兼容读取。
 * 读取侧全部做 id 白名单校验，
 * 拒绝路径穿越。仓库目录之外只写这一处。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile, copyFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { PageQualityMeta, PageReviewMeta, SourceExcerpt, WikiManifest, WikiPageMeta, WikiPageType } from '../shared/types.js'
import { WikiError } from './errors.js'

/** wikiId / pageId 白名单：小写字母、数字、连字符。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function assertSafeId(value: string, label = 'id'): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new WikiError(`非法的${label}：${String(value).slice(0, 80)}`, 'repowiki/invalid-id')
  }
  return value
}

/** 同一绝对路径得到同一 wikiId；Windows 上路径大小写不敏感。 */
export function wikiIdFor(repoPath: string): string {
  const resolved = resolve(repoPath)
  const base = basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo'
  const hash = createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

export function wikisRoot(stateDir: string): string {
  return join(stateDir, 'wikis')
}

export interface WritePageInput {
  readerQuestion?: string
  scope?: string
  relatedPageIds?: string[]

  kind?: 'group' | 'page'
  type?: WikiPageType
  parentId?: string | null
  sources?: SourceExcerpt[]
  quality?: PageQualityMeta
  verification?: 'supported' | 'uncertain'
  verificationIssues?: string[]
  review?: PageReviewMeta
  id: string
  title: string
  summary: string
  content: string
  related: string[]
}

/**
 * 独立版本写入；发布清单前失败或取消不改变上一版可读状态。
 */
export async function writeWiki(stateDir: string, manifest: Omit<WikiManifest, 'pages'>, pages: WritePageInput[], signal?: AbortSignal): Promise<WikiManifest> {
  assertSafeId(manifest.id, 'wikiId')
  const dir = join(wikisRoot(stateDir), manifest.id)
  const revision = randomUUID()
  const revisionDir = join(dir, 'revisions', revision)
  const pagesDir = join(revisionDir, 'pages')
  await mkdir(pagesDir, { recursive: true })
  await mkdir(join(revisionDir, 'sources'), { recursive: true })
  const listed: WikiPageMeta[] = []
  for (const page of pages) {
    signal?.throwIfAborted()
    assertSafeId(page.id, 'pageId')
    const file = `revisions/${revision}/pages/${page.id}.md`
    if (page.kind !== 'group') await writeFile(join(dir, ...file.split('/')), page.content, 'utf8')
    for (const source of page.sources ?? []) {
      assertSafeId(source.id, 'sourceId')
      await writeFile(join(revisionDir, 'sources', `${source.id}.json`), JSON.stringify(source), 'utf8')
    }
    listed.push({ readerQuestion: page.readerQuestion, scope: page.scope, relatedPageIds: page.relatedPageIds, kind: page.kind, type: page.type, id: page.id, title: page.title, summary: page.summary, file, parentId: page.parentId ?? null,
      quality: page.quality, verification: page.verification, verificationIssues: page.verificationIssues, review: page.review,
      sources: (page.sources ?? []).map(({ text: _, ...source }) => source),
      bytes: Buffer.byteLength(page.content, 'utf8'), related: page.related })
  }
  // Incremental publication may remove pages while retaining a previous route list.
  // Keep stable IDs and order, but never publish links to missing pages or groups.
  const bodyIds = new Set(listed.filter(page => page.kind !== 'group').map(page => page.id))
  const keepRoute = (ids: string[]) => [...new Set(ids)].filter(id => bodyIds.has(id))
  const readingPaths = manifest.readingPaths && {
    user: keepRoute(manifest.readingPaths.user),
    developer: keepRoute(manifest.readingPaths.developer),
    maintainer: keepRoute(manifest.readingPaths.maintainer),
  }
  const finalManifest: WikiManifest = { ...manifest, readingPaths, schemaVersion: manifest.generator.endsWith('/agent-v1') ? 4 : 3, revision, pages: listed }
  await writeFile(join(revisionDir, 'manifest.json'), JSON.stringify(finalManifest, null, 2), 'utf8')
  const nextManifest = join(dir, `manifest-${revision}.tmp`)
  await writeFile(nextManifest, JSON.stringify(finalManifest, null, 2), 'utf8')
  signal?.throwIfAborted()
  await copyFile(join(dir, 'manifest.json'), join(dir, 'manifest.pre-v3.bak'), 1).catch(e => { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e })
  if (manifest.generator.endsWith('/agent-v1')) await copyFile(join(dir, 'manifest.json'), join(dir, 'manifest.pre-v5.bak'), 1).catch(e => { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e })
  signal?.throwIfAborted()
  await rename(nextManifest, join(dir, 'manifest.json'))
  return finalManifest
}

function parseManifest(raw: string): WikiManifest | null {
  try {
    const manifest = JSON.parse(raw) as WikiManifest | null
    if (!manifest || typeof manifest.id !== 'string' || !Array.isArray(manifest.pages)) return null
    return manifest
  } catch { return null }
}

export async function readManifest(stateDir: string, wikiId: string): Promise<WikiManifest | null> {
  assertSafeId(wikiId, 'wikiId')
  const raw = await readFile(join(wikisRoot(stateDir), wikiId, 'manifest.json'), 'utf8').catch(() => null)
  return raw === null ? null : parseManifest(raw)
}

export async function readPageContent(stateDir: string, wikiId: string, pageId: string, manifest?: WikiManifest): Promise<string | null> {
  assertSafeId(wikiId, 'wikiId')
  assertSafeId(pageId, 'pageId')
  const current = manifest ?? await readManifest(stateDir, wikiId)
  if (!current?.pages.some(page => page.id === pageId && page.kind !== 'group')) return null
  const file = current.revision
    ? join(wikisRoot(stateDir), wikiId, 'revisions', assertSafeId(current.revision, 'revision'), 'pages', `${pageId}.md`)
    : join(wikisRoot(stateDir), wikiId, 'pages', `${pageId}.md`)
  return await readFile(file, 'utf8').catch(() => null)
}

export async function readSourceContent(stateDir: string, manifest: WikiManifest, sourceId: string): Promise<SourceExcerpt> {
  assertSafeId(manifest.id, 'wikiId')
  assertSafeId(sourceId, 'sourceId')
  if (!manifest.revision || !manifest.pages.some(p => p.sources?.some(s => s.id === sourceId))) throw new WikiError('引用不存在。', 'repowiki/source-not-found')
  assertSafeId(manifest.revision, 'revision')
  const source = JSON.parse(await readFile(join(wikisRoot(stateDir), manifest.id, 'revisions', manifest.revision, 'sources', `${sourceId}.json`), 'utf8')) as SourceExcerpt
  if (source.id !== sourceId || createHash('sha256').update(source.text).digest('hex') !== source.hash) throw new WikiError('引用快照校验失败。', 'repowiki/source-invalid')
  return source
}

/** 列出全部维基；单个损坏的 manifest 只跳过不报错，按 updatedAt 倒序。 */
export async function listWikis(stateDir: string): Promise<WikiManifest[]> {
  let entries
  try { entries = await readdir(wikisRoot(stateDir), { withFileTypes: true }) } catch { return [] }
  const wikis: WikiManifest[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
    const raw = await readFile(join(wikisRoot(stateDir), entry.name, 'manifest.json'), 'utf8').catch(() => null)
    const manifest = raw === null ? null : parseManifest(raw)
    if (manifest && manifest.id === entry.name) wikis.push(manifest)
  }
  wikis.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return wikis
}
