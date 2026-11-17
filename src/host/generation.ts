import type { GenerationStatus } from '../shared/types.js'
import type { Checkpoint, CheckpointStore } from './checkpoints.js'
import { WikiError } from './errors.js'
import { gitState } from './git.js'
import { captureSnapshot, asMaterial, selectMaterial } from './snapshot.js'
import { pagePrompts, planPrompts, validateOutline } from './prompts.js'
import { extractJsonObject } from './llm.js'
import { readManifest, readPageContent, readSourceContent, writeWiki, type WritePageInput } from './store.js'
import { cardPrompts, parseCard, verifyPrompts, applyVerification, verifySources } from './cards.js'
import { markUnverifiedCitations } from './citations.js'
import { aggregateQuality, compactQuality, evaluatePage } from './quality.js'
import { augmentPages } from './ast-flow.js'
import { decodeBounded } from './scanner.js'

interface Runtime {
  stateDir: string; checkpoints: CheckpointStore; maxPageBytes: number
  save: () => Promise<void>; complete: (prompts: { system: string; user: string }) => Promise<string>
}
/** All model operations run through at most three workers; stages never overlap. */
export async function generate(job: Checkpoint, signal: AbortSignal, runtime: Runtime): Promise<void> {
  const s = job.status
  const stage = async (value: GenerationStatus['stage']) => { signal.throwIfAborted(); s.stage = value; await runtime.save() }
  await stage('scan')
  const old = await readManifest(runtime.stateDir, s.wikiId!)
  if (job.mode === 'update' && !job.commit) job.commit = (await gitState(s.repoPath!)).commit ?? undefined
  let snapshot = await runtime.checkpoints.snapshot(s.jobId!)
  if (!snapshot) { snapshot = await captureSnapshot(s.repoPath!, job.commit, signal, false, job.settings.exclude); await runtime.checkpoints.saveSnapshot(s.jobId!, snapshot) }
  if (job.mode === 'update' && old?.source && snapshot.source.branch !== old.source.branch) throw new WikiError('分支已切换，请重新生成。', 'repowiki/branch-changed')
  if (!verifySources(job.pages.flatMap(p => p.sources ?? []), snapshot.files)) throw new WikiError('检查点与源码快照不一致。', 'repowiki/checkpoint-source')
  await stage('analyze')
  const sourceIndex = snapshot.files.map(({ path, hash }) => ({ path, hash }))
  const oldIndex = new Map((old?.sourceIndex ?? []).map(f => [f.path, f.hash]))
  const newIndex = new Map(sourceIndex.map(f => [f.path, f.hash]))
  const changed = new Set([...oldIndex.keys(), ...newIndex.keys()].filter(p => oldIndex.get(p) !== newIndex.get(p)))
  job.analysis = JSON.stringify({ files: snapshot.files.length, changed: [...changed], truncated: snapshot.truncated,
    manifests: snapshot.files.filter(f => /(?:^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(f.path)).map(f => f.path) })
  const canReuse = job.mode === 'update' && old?.language === job.settings.language && !!old.sourceIndex && !!old.revision
  const structural = !canReuse || old!.pages.length > job.settings.maxPages || [...changed].some(p => !oldIndex.has(p) || !newIndex.has(p))
    || [...changed].some(p => /(?:^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|.*config\.[^/]+)$/.test(p))
  await stage('plan')
  if (!job.outline) {
    if (structural) {
      const prompts = planPrompts({ scan: asMaterial(snapshot, selectMaterial(snapshot)), language: job.settings.language, maxPages: job.settings.maxPages })
      prompts.user = `仓库分析：${job.analysis}\n${prompts.user}`
      job.outline = validateOutline(extractJsonObject(await runtime.complete(prompts)), { maxPages: job.settings.maxPages })
      for (const page of job.outline.pages) if (page.relatedPaths.some(p => !snapshot!.files.some(f => f.path === p || f.path.startsWith(`${p.replace(/\/$/, '')}/`)))) throw new WikiError(`大纲引用了未读取的文件：${page.id}`, 'repowiki/invalid-outline')
    } else job.outline = { title: old!.title, description: old!.description, readingPaths: old!.readingPaths, pages: old!.pages.map(p => ({ id: p.id, kind: p.kind, readerQuestion: p.readerQuestion, scope: p.scope, relatedPageIds: p.relatedPageIds, title: p.title, summary: p.summary, parentId: p.parentId, relatedPaths: p.related })) }
  }
  const outline = job.outline
  const contentPages = outline.pages.filter(p => p.kind !== 'group')
  s.pagesTotal = contentPages.length
  s.items = contentPages.map(p => ({ id: p.id, title: p.title, parentId: p.parentId ?? null, state: job.pages.some(x => x.id === p.id) ? 'complete' : 'pending', step: 'pages', error: null }))
  await runtime.save()
  const parallel = async (step: 'pages' | 'cards' | 'verify', work: (page: typeof outline.pages[number]) => Promise<void>) => {
    await stage(step)
    let cursor = 0
    const workers = await Promise.allSettled(Array.from({ length: Math.min(3, contentPages.length) }, async () => {
      while (cursor < contentPages.length && !signal.aborted) {
        const page = contentPages[cursor++]!, item = s.items!.find(i => i.id === page.id)!
        if (item.state === 'failed') continue
        item.step = step; item.state = 'writing'; s.currentPage = s.items!.filter(i => i.state === 'writing').map(i => i.title).join('、'); s.processing = (s.processing ?? 0) + 1
        try { await runtime.save(); signal.throwIfAborted(); await work(page); item.state = 'complete'; item.error = null }
        catch (error) {
          item.state = signal.aborted ? 'pending' : 'failed'
          item.error = signal.aborted ? null : error instanceof Error ? error.message : String(error)
        } finally {
          s.processing = Math.max(0, (s.processing ?? 1) - 1)
          s.currentPage = s.items!.filter(i => i.state === 'writing').map(i => i.title).join('、') || null
          s.pagesDone = job.pages.length; s.cardsDone = job.cards.length
          await runtime.save()
        }
      }
    }))
    const failed = workers.find(r => r.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    signal.throwIfAborted()
  }
  await parallel('pages', async page => {
    if (job.pages.some(p => p.id === page.id)) return
    const previous = old?.pages.find(p => p.id === page.id)
    const reusable = canReuse && previous?.sources?.length && previous.title === page.title && previous.summary === page.summary
      && (previous.parentId ?? null) === (page.parentId ?? null) && !previous.sources.some(f => changed.has(f.path))
      && !page.relatedPaths.some(p => [...changed].some(f => f === p || f.startsWith(`${p}/`))) && !(page.id === 'overview' && changed.size)
    const gatePage = (candidate: WritePageInput): WritePageInput => {
      const quality = evaluatePage(page, candidate.content, candidate.sources ?? [], snapshot!.files.map(file => file.path))
      if (job.qualityPolicy === 'enforce' && quality.hard.length) throw new WikiError(`页面质量硬性失败：${page.id}：${quality.hard.join('；')}`, 'repowiki/page-quality')
      return { ...candidate, quality: compactQuality(quality) }
    }
    let result: WritePageInput
    if (reusable) {
      const content = await readPageContent(runtime.stateDir, old!.id, page.id, old!)
      if (content === null) throw new WikiError('旧版本页面缺失。', 'repowiki/page-not-found')
      // Rebase unchanged excerpts onto the new snapshot version, so every published source shares this snapshot.
      const previousSources = await Promise.all(previous.sources!.map(f => readSourceContent(runtime.stateDir, old!, f.id)))
      const sources = previousSources.map(s => selectMaterial(snapshot!, [s.path], Buffer.byteLength(s.text))[0]!).filter(Boolean)
      result = gatePage({ ...page, content, related: previous.related, sources, verification: previous.verification, verificationIssues: previous.verificationIssues, review: previous.review })
      const card = old?.cards?.find(c => c.pageId === page.id)
      if (card && sources.length === previousSources.length) {
        const copy = structuredClone(card); copy.version = sources[0]?.version ?? ''
        copy.evidence = copy.evidence.map(e => ({ ...e, sourceId: sources.find(s => s.path === e.path)?.id ?? e.sourceId }))
        job.cards.push(copy); job.verified.push(page.id)
      }
    } else {
      const sources = selectMaterial(snapshot!, page.relatedPaths, 80 * 1024)
      if (!sources.length) throw new WikiError(`页面没有可用来源：${page.title}`, 'repowiki/no-sources')
      const text = await runtime.complete(pagePrompts({ scan: asMaterial(snapshot!, sources), outline, page, language: job.settings.language, materialBudget: Number.MAX_SAFE_INTEGER }))
      const content = Buffer.byteLength(text) > runtime.maxPageBytes ? `${decodeBounded(Buffer.from(text).subarray(0, runtime.maxPageBytes))}\n\n> 内容超过页面字节上限，已截断。` : text
      result = gatePage({ ...page, content: markUnverifiedCitations(content, sources, job.settings.language, snapshot!.files.map(file => file.path)), related: sources.map(s => s.path), sources })
    }
    signal.throwIfAborted(); job.pages.push(result)
  })
  await parallel('cards', async page => {
    if (job.cards.some(c => c.pageId === page.id)) return
    const written = job.pages.find(p => p.id === page.id)!
    const card = parseCard(extractJsonObject(await runtime.complete(cardPrompts(written, job.settings.language))), written)
    signal.throwIfAborted(); job.cards.push(card)
  })
  await parallel('verify', async page => {
    if (job.verified.includes(page.id)) return
    const written = job.pages.find(p => p.id === page.id)!, card = job.cards.find(c => c.pageId === page.id)!
    const response = extractJsonObject(await runtime.complete(verifyPrompts(written, card)))
    signal.throwIfAborted()
    const outcome = applyVerification(response, card)
    if (job.qualityPolicy === 'enforce' && !outcome.review) throw new WikiError('核验必须提交可读性审阅 review。', 'repowiki/review-required')
    written.verification = outcome.supported ? 'supported' : 'uncertain'
    written.verificationIssues = outcome.issues
    written.review = outcome.review
    job.verified.push(page.id)
  })
  if (s.items.some(i => i.state === 'failed')) throw new WikiError('部分页面或卡片失败；已保存草稿，可重试未完成项。', 'repowiki/partial')
  await stage('write')
  const now = new Date().toISOString()
  const legacyPages: WritePageInput[] = outline.pages.map(p => p.kind === 'group' ? { ...p, content: '', related: [] } : job.pages.find(w => w.id === p.id)!)
  // 旧引擎同样在发布前注入确定性结构图，保持两种引擎的阅读形态一致。
  await augmentPages(legacyPages, snapshot.files, job.settings.language, id => outline.pages.find(p => p.id === id)?.type)
  const saved = await writeWiki(runtime.stateDir, { id: s.wikiId!, repoPath: s.repoPath!, title: outline.title, description: outline.description, readingPaths: outline.readingPaths,
    language: job.settings.language, createdAt: old?.createdAt ?? now, updatedAt: now, generator: 'dsh-repowiki', jobId: s.jobId,
    source: snapshot.source, sourceIndex, model: job.selection, cards: contentPages.map(p => job.cards.find(c => c.pageId === p.id)!) },
    legacyPages, signal)
  s.result = { wikiId: saved.id, title: saved.title, pageCount: contentPages.length, refs: saved.pages.reduce((n, p) => n + p.related.length, 0) }
  if (snapshot.truncated) s.warning = '仓库材料超过扫描上限，部分文件或内容未纳入；请结合引用确认覆盖范围。'
  s.quality = aggregateQuality(contentPages.map(page => {
    const written = job.pages.find(p => p.id === page.id)!
    return { content: written.content, sources: written.sources ?? [], quality: written.quality! }
  }), job.verified.length, s.warning ? [s.warning] : [])
  await runtime.save()
}
