import { digest } from './agent-workspace.js'
import type { AgentRunner } from './agent-generation.js'
import { generate } from './generation.js'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GenerationStatus, ModelSelection, ProjectConfiguration, ProjectSettings, WikiManifest, DraftResponse, ReadPageResponse, SourceExcerpt, SearchWikiResponse } from '../shared/types.js'
import { WikiError } from './errors.js'
import { completeText, resolveSelection, type GenerationAgent } from './llm.js'
import { readExcerpts, scanRepo } from './scanner.js'
import { listWikis, readManifest, readPageContent, wikiIdFor } from './store.js'
import { ProjectSettingsStore, validateSettings } from './settings.js'
import { gitState } from './git.js'
import { exportWiki } from './exporter.js'
import { CheckpointStore, type Checkpoint } from './checkpoints.js'

export const DEFAULT_CONFIG = { language: 'zh', maxPages: 32, pageTimeoutMs: 600_000, plannerAttemptTimeoutMs: 600_000, totalTimeoutMs: 1_800_000, maxPageBytes: 32 * 1024, agentJobTimeoutMs: 7_200_000, stalledMinutes: 30, exclude: [] as string[] }
export interface PipelineConfig extends Partial<typeof DEFAULT_CONFIG> {}
type LlmRuntime = Parameters<typeof completeText>[0]['llm']
interface StartOptions {
  repoPath: unknown; agent?: GenerationAgent; sessionId?: string; selection?: ModelSelection; signal?: AbortSignal
  mode?: 'generate' | 'update'; trigger?: 'manual' | 'auto'; commit?: string
}
interface Job extends Checkpoint {
  controller: AbortController; settled?: Promise<void>
}
const idle = (): GenerationStatus => ({ running: false, stage: 'idle', wikiId: null, repoPath: null, pagesDone: 0, pagesTotal: 0, error: null, result: null })
const bounded = (n: unknown, fallback: number, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : fallback
const roleSelections = (settings: ProjectSettings): ModelSelection[] =>
  [settings.roles?.planner, settings.roles?.writer, settings.roles?.verifier].filter((model): model is ModelSelection => !!model)

/** Host-owned queue. Caller signals only guard submission, never the lifetime of a job. */
export class WikiPipeline {
  readonly config: typeof DEFAULT_CONFIG
  readonly stateDir: string
  readonly projectSettings: ProjectSettingsStore
  private readonly checkpoints: CheckpointStore
  readonly ready: Promise<void>
  private readonly jobs = new Map<string, Job>()
  private readonly queue: Job[] = []
  private active: Job | null = null
  private disposed = false
  private polling = false
  private readonly timer: ReturnType<typeof setInterval> | undefined
  private readonly exports = new Map<string, Promise<Awaited<ReturnType<typeof exportWiki>>>>()
  private readonly agentRunner?: AgentRunner
  private readonly newEngine: 'agent-v1' | 'legacy'
  private readonly qualityPolicy: 'enforce' | 'legacy'
  private readonly getLlm: () => LlmRuntime
  private readonly getDefaultModel?: () => ModelSelection
  private readonly validateModel?: (model: ModelSelection) => Promise<void>
  private readonly log: (line: string) => void

  constructor(options: { config?: PipelineConfig; stateDir: string; getLlm: () => LlmRuntime; log?: (line: string) => void;
    agentRunner?: AgentRunner; newEngine?: 'agent-v1' | 'legacy'; qualityPolicy?: 'enforce' | 'legacy'; getDefaultModel?: () => ModelSelection; validateModel?: (model: ModelSelection) => Promise<void>; autoPollMs?: number }) {
    if (!options.stateDir?.trim() || typeof options.getLlm !== 'function') throw new WikiError('仓库维基插件配置不完整。', 'repowiki/config')
    const c = options.config ?? {}
    this.config = { language: c.language === 'en' ? 'en' : 'zh', maxPages: Math.floor(bounded(c.maxPages, 32, 1, 64)),
      pageTimeoutMs: bounded(c.pageTimeoutMs, DEFAULT_CONFIG.pageTimeoutMs, 5_000, 3_600_000),
      plannerAttemptTimeoutMs: bounded(c.plannerAttemptTimeoutMs, DEFAULT_CONFIG.plannerAttemptTimeoutMs, 60_000, 1_800_000),
      totalTimeoutMs: bounded(c.totalTimeoutMs, DEFAULT_CONFIG.totalTimeoutMs, 10_000, 7_200_000),
      maxPageBytes: bounded(c.maxPageBytes, DEFAULT_CONFIG.maxPageBytes, 4096, 256 * 1024),
      agentJobTimeoutMs: bounded(c.agentJobTimeoutMs, DEFAULT_CONFIG.agentJobTimeoutMs, 60_000, 7_200_000),
      stalledMinutes: bounded(c.stalledMinutes, DEFAULT_CONFIG.stalledMinutes, 1, 240),
      exclude: Array.isArray(c.exclude) ? c.exclude.filter((rule): rule is string => typeof rule === 'string' && rule.trim() !== '').map(rule => rule.trim()).slice(0, 200) : [] }
    this.stateDir = options.stateDir; this.getLlm = options.getLlm; this.log = options.log ?? (() => {})
    this.agentRunner = options.agentRunner; this.newEngine = options.newEngine ?? 'agent-v1'; this.qualityPolicy = options.qualityPolicy ?? 'enforce'
    this.getDefaultModel = options.getDefaultModel; this.validateModel = options.validateModel
    this.projectSettings = new ProjectSettingsStore(this.stateDir, { language: this.config.language as 'zh' | 'en', model: null,
      maxPages: this.config.maxPages, autoUpdate: false, autoExport: false, agentReference: true,
      collaboration: 'collaborative', concurrency: 2, granularity: 'standard', roles: {} })
    this.checkpoints = new CheckpointStore(this.stateDir)
    this.ready = this.restore()
    if (options.autoPollMs !== 0) {
      this.timer = setInterval(() => { void this.pollAutoUpdates().catch(e => this.log(`[auto] ${String(e)}`)) }, options.autoPollMs ?? 60_000)
      this.timer.unref()
    }
  }
  get settings(): typeof DEFAULT_CONFIG & { outputDir: string } { return { ...this.config, outputDir: join(this.stateDir, 'wikis') } }
  private async save(job: Job): Promise<void> {
    job.status.checkpointAt = new Date().toISOString()
    job.status.recoverable = !job.status.result && !job.status.running
    const { controller: _, settled: __, ...data } = job
    await this.checkpoints.save(data)
  }
  private async restore(): Promise<void> {
    for (const data of await this.checkpoints.list()) {
      const job: Job = { ...data, controller: new AbortController() }
      const wasRunning = job.status.running
      // A crash between manifest commit and final checkpoint must not republish the job.
      const published = data.status.wikiId ? await readManifest(this.stateDir, data.status.wikiId) : null
      if (published && published.jobId === data.status.jobId) {
        job.status.result = { wikiId: published.id, title: published.title, pageCount: published.pages.filter(p => p.kind !== 'group').length, refs: published.pages.reduce((n, p) => n + p.related.length, 0) }
        job.status.stage = 'done'; job.status.running = false
      } else if (job.status.running) {
        job.status.stage = 'interrupted'; job.status.running = false
        job.status.error = { code: 'repowiki/interrupted', message: '宿主重启，已保留草稿；请手动恢复。' }
      }
      job.status.processing = 0
      job.status.recoverable = !job.status.result && !job.status.running
      this.jobs.set(data.status.jobId!, job)
      if (wasRunning) await this.save(job)
    }
  }
  async pause(jobId: string): Promise<GenerationStatus> {
    await this.ready
    const job = this.jobs.get(jobId)
    if (!job?.status.running || job.status.result) throw new WikiError('任务当前不能暂停。', 'repowiki/no-job')
    job.controller.abort(new WikiError('任务已暂停，可从检查点继续。', 'repowiki/paused'))
    const index = this.queue.indexOf(job)
    if (index >= 0) { this.queue.splice(index, 1); job.status.stage = 'paused'; job.status.running = false; await this.save(job) }
    await job.settled
    return this.status(jobId)
  }
  async resume(jobId: string): Promise<GenerationStatus> {
    await this.ready
    const job = this.jobs.get(jobId)
    if (!job || job.status.result || job.status.running) throw new WikiError('任务当前不能恢复。', 'repowiki/no-job')
    await job.settled
    if (this.disposed) throw new WikiError('插件已卸载。', 'repowiki/disposed')
    if ([...this.jobs.values()].some(j => j !== job && j.status.wikiId === job.status.wikiId && j.status.running)) throw new WikiError('同项目已有运行中的任务。', 'repowiki/busy')
    await this.validateModel?.(job.selection)
    if (job.settings.collaboration === 'collaborative') for (const model of roleSelections(job.settings)) await this.validateModel?.(model)
    job.controller = new AbortController()
    Object.assign(job.status, { stage: 'queued', running: true, error: null, finishedAt: null, recoverable: false })
    await this.save(job); this.queue.push(job); this.drain()
    return this.status(jobId)
  }
  async draft(jobId: string): Promise<DraftResponse> {
    await this.ready
    const job = this.jobs.get(jobId)
    if (!job) throw new WikiError('任务不存在。', 'repowiki/no-job')
    const snapshot = await this.checkpoints.snapshot(jobId)
    return { status: this.status(jobId), wiki: job.outline ? { id: job.status.wikiId!, title: job.outline.title, description: job.outline.description, readingPaths: job.outline.readingPaths,
      repoPath: job.status.repoPath!, language: job.settings.language, createdAt: job.status.startedAt!, updatedAt: job.status.checkpointAt!,
      generator: 'dsh-repowiki', revision: jobId, source: snapshot?.source, model: job.selection, cards: structuredClone(job.cards),
      pages: job.outline.pages.map(p => { const written = job.pages.find(w => w.id === p.id); return { ...p, contentVersion: written ? digest(written.content) : undefined, file: '', bytes: written ? Buffer.byteLength(written.content) : 0,
        related: written?.related ?? p.relatedPaths, sources: written?.sources?.map(({ text: _, ...s }) => s) ?? [],
        quality: written?.quality, verification: written?.verification, verificationIssues: written?.verificationIssues, review: written?.review } }) } : null }
  }
  async draftPage(jobId: string, pageId: string): Promise<ReadPageResponse['page']> {
    await this.ready
    const page = this.jobs.get(jobId)?.pages.find(p => p.id === pageId)
    if (!page) throw new WikiError('页面尚未完成。', 'repowiki/page-pending')
    return { id: page.id, title: page.title, summary: page.summary, content: page.content }
  }
  async draftSource(jobId: string, sourceId: string): Promise<SourceExcerpt> {
    await this.ready
    const job = this.jobs.get(jobId)
    const source = job?.agentState?.evidence.find(s => s.id === sourceId) ?? job?.pages.flatMap(p => p.sources ?? []).find(s => s.id === sourceId)
    if (!source) throw new WikiError('引用不存在。', 'repowiki/source-not-found')
    return structuredClone(source)
  }
  async searchDraft(jobId: string, query: string): Promise<SearchWikiResponse> {
    await this.ready
    const job = this.jobs.get(jobId)
    if (!job) throw new WikiError('任务不存在。', 'repowiki/no-job')
    const needle = query.trim().slice(0, 200).toLowerCase()
    return { pages: (job.outline?.pages ?? []).flatMap(p => {
      const text = `${p.title}\n${p.summary}\n${job.pages.find(w => w.id === p.id)?.content ?? ''}`
      const index = text.toLowerCase().indexOf(needle)
      return index < 0 ? [] : [{ id: p.id, title: p.title, snippet: text.slice(Math.max(0, index - 30), index + 130) }]
    }) }
  }
  async configuration(path: string, signal?: AbortSignal): Promise<ProjectConfiguration> {
    signal?.throwIfAborted()
    const record = await this.projectSettings.read(path)
    const git = await gitState(record.path, signal)
    let reason: string | null = null
    try {
      const scan = await scanRepo(record.path, { exclude: [...this.config.exclude, ...(record.settings.exclude ?? [])] }, signal)
      if (!scan.docs.some(d => d.text.trim()) && !(await readExcerpts(scan, undefined, signal)).some(f => f.text.trim())) reason = '没有可用于生成的项目文件。'
    } catch (error) { signal?.throwIfAborted(); reason = error instanceof Error ? error.message : '无法读取项目。' }
    return { path: record.path, settings: record.settings, canGenerate: reason === null, reason,
      git: { available: git.available, branch: git.branch, commit: git.commit }, updateNotice: record.updateNotice }
  }
  async saveSettings(path: string, value: ProjectSettings, signal?: AbortSignal): Promise<ProjectConfiguration> {
    signal?.throwIfAborted()
    const settings = validateSettings(value)
    const record = await this.projectSettings.read(path)
    if (settings.autoUpdate && !(await gitState(record.path, signal)).available) throw new WikiError('自动更新仅支持已有提交的 Git 仓库。', 'repowiki/not-git')
    if (settings.model) await this.validateModel?.(settings.model)
    for (const model of roleSelections(settings)) await this.validateModel?.(model)
    await this.projectSettings.update(path, current => ({ ...current, settings }))
    signal?.throwIfAborted()
    return this.configuration(path, signal)
  }
  async start(options: StartOptions): Promise<{ started: boolean; wikiId: string; repoPath: string; jobId: string }> {
    await this.ready
    if (this.disposed) throw new WikiError('插件已卸载。', 'repowiki/disposed')
    if (typeof options.repoPath !== 'string' || !options.repoPath.trim()) throw new WikiError('请提供仓库根目录路径。', 'repowiki/missing-path')
    const path = resolve(options.repoPath.trim()), wikiId = wikiIdFor(path)
    const existing = () => [...this.jobs.values()].find(j => j.status.wikiId === wikiId && j.status.running)
    const dedup = (job: Job) => {
      if (options.trigger === 'auto' && job.status.stage === 'queued' && job.status.trigger === 'auto' && options.commit) job.commit = options.commit
      return { started: false, wikiId, repoPath: path, jobId: job.status.jobId! }
    }
    const previous = existing(); if (previous) return dedup(previous)
    options.signal?.throwIfAborted()
    const info = await stat(path).catch(() => null)
    if (!info) throw new WikiError(`仓库路径不存在或不可访问：${path}`, 'repowiki/path-not-found')
    if (!info.isDirectory()) throw new WikiError('仓库路径不是目录。', 'repowiki/not-a-directory')
    if (options.trigger !== 'auto') {
      const available = await this.configuration(path, options.signal)
      if (!available.canGenerate) throw new WikiError(available.reason ?? '没有可读取内容。', 'repowiki/empty-repo')
    }
    const record = await this.projectSettings.read(path)
    // 插件级排除规则先于项目规则生效：项目级只能在此基础上继续排除。
    const scanExclude = [...this.config.exclude, ...(record.settings.exclude ?? [])]
    const selection = structuredClone(record.settings.model ?? options.selection ?? (options.agent ? resolveSelection(options.agent) : this.getDefaultModel?.() ?? resolveSelection(undefined)))
    await this.validateModel?.(selection)
    if (record.settings.collaboration === 'collaborative') for (const model of roleSelections(record.settings)) await this.validateModel?.(model)
    options.signal?.throwIfAborted()
    if (this.disposed) throw new WikiError('插件已卸载。', 'repowiki/disposed')
    const raced = existing(); if (raced) return dedup(raced)
    const jobId = randomUUID()
    // Persist new-project defaults before publishing makes this look like a legacy Wiki.
    await this.projectSettings.update(path, current => current)
    const effectiveMode = options.mode ?? 'generate'
    const job: Job = { schemaVersion: this.newEngine === 'agent-v1' ? 2 : 1, engine: this.newEngine === 'agent-v1' ? 'agent-v1' : undefined, pages: [], cards: [], verified: [], status: { ...idle(), engine: this.newEngine, collaboration: record.settings.collaboration ?? 'collaborative', running: true, jobId, wikiId, repoPath: path, stage: 'queued', model: selection,
      currentPage: null, startedAt: new Date().toISOString(), finishedAt: null, trigger: options.trigger ?? 'manual', warning: null },
      selection, settings: { ...structuredClone(record.settings), exclude: scanExclude }, controller: new AbortController(), mode: effectiveMode,
      qualityPolicy: this.qualityPolicy, readingPlanRequired: true, commit: options.commit, sessionId: options.sessionId ?? options.agent?.id }
    await this.save(job)
    this.jobs.set(jobId, job); this.queue.push(job)
    // Keep recent results, without dropping active/queued tasks.
    if (this.jobs.size > 100) for (const [id, old] of this.jobs) { if (!old.status.running && id !== jobId) this.jobs.delete(id); if (this.jobs.size <= 100) break }
    this.drain()
    return { started: true, wikiId, repoPath: path, jobId }
  }
  status(jobId?: string): GenerationStatus {
    const job = jobId ? this.jobs.get(jobId) : this.active ?? [...this.jobs.values()].at(-1)
    if (jobId && !job) throw new WikiError('任务不存在或已超出保留范围。', 'repowiki/no-job')
    return structuredClone(job?.status ?? idle())
  }
  statuses(): GenerationStatus[] { return [...this.jobs.values()].reverse().map(j => structuredClone(j.status)) }
  cancel(jobId?: string): { cancelled: boolean; wikiId: string } {
    const job = jobId ? this.jobs.get(jobId) : this.active ?? this.queue[0]
    if (!job?.status.running) throw new WikiError('当前没有正在进行的生成任务。', 'repowiki/no-job')
    // Once the manifest was committed, export cannot undo the successful wiki.
    if (job.status.result) return { cancelled: false, wikiId: job.status.wikiId! }
    job.controller.abort(new WikiError('生成已取消。', 'repowiki/cancelled'))
    if (job.status.stage === 'queued') {
      const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1)
      Object.assign(job.status, { stage: 'cancelled', running: false, finishedAt: new Date().toISOString() })
      void this.save(job).catch(e => this.log(String(e)))
    }
    return { cancelled: true, wikiId: job.status.wikiId! }
  }
  async list(): Promise<WikiManifest[]> { return listWikis(this.stateDir) }
  async readManifest(wikiId: unknown): Promise<WikiManifest> {
    const manifest = await readManifest(this.stateDir, typeof wikiId === 'string' ? wikiId : '')
    if (!manifest) throw new WikiError('维基不存在。', 'repowiki/not-found')
    return manifest
  }
  async readPage(wikiId: unknown, pageId: unknown, revision?: string): Promise<{ id: string; title: string; summary: string; content: string }> {
    const manifest = await this.readManifest(wikiId)
    if (revision && manifest.revision !== revision) throw new WikiError('Wiki 版本已更新，请重新打开页面。', 'repowiki/stale-version')
    const page = manifest.pages.find(p => p.id === pageId)
    if (!page) throw new WikiError('页面不存在。', 'repowiki/page-not-found')
    const content = await readPageContent(this.stateDir, manifest.id, page.id, manifest)
    if (content === null) throw new WikiError('页面内容缺失。', 'repowiki/page-not-found')
    return { id: page.id, title: page.title, summary: page.summary, content }
  }
  async export(wikiId: string): Promise<Awaited<ReturnType<typeof exportWiki>>> {
    const pending = this.exports.get(wikiId); if (pending) return pending
    const operation = this.readManifest(wikiId).then(wiki => exportWiki(this.stateDir, wiki))
    this.exports.set(wikiId, operation)
    try { return await operation } finally { this.exports.delete(wikiId) }
  }
  async pollAutoUpdates(): Promise<void> {
    await this.ready
    if (this.polling || this.disposed) return
    this.polling = true
    try {
      for (const record of await this.projectSettings.list()) {
        if (this.disposed || !record.settings.autoUpdate) continue
        const latest = this.statuses().find(s => s.wikiId === wikiIdFor(record.path))
        if (latest && ['paused', 'interrupted'].includes(latest.stage)) continue
        try {
          const manifest = await readManifest(this.stateDir, wikiIdFor(record.path))
          if (!manifest?.source) continue
          const state = await gitState(record.path)
          if (!state.available || !state.commit) continue
          if (state.branch !== manifest.source.branch) {
            if (record.updateNotice !== '分支已切换，自动更新已暂停；请重新生成。') await this.projectSettings.update(record.path, current => ({ ...current, updateNotice: '分支已切换，自动更新已暂停；请重新生成。' }))
            continue
          }
          if (record.updateNotice?.includes('分支已切换')) continue
          if (state.commit === manifest.source.commit || state.commit === record.blockedCommit) continue
          await this.start({ repoPath: record.path, mode: 'update', trigger: 'auto', commit: state.commit })
        } catch (error) {
          // Discovery/model failures also block this commit, avoiding a periodic retry storm.
          const state = await gitState(record.path)
          const failure = error instanceof Error ? error.message : '自动更新失败，请手动重试。'
          await this.projectSettings.update(record.path, current => ({ ...current, blockedCommit: state.commit, updateNotice: failure }))
          const jobId = randomUUID()
          this.jobs.set(jobId, { schemaVersion: 1, pages: [], cards: [], verified: [], status: { ...idle(), stage: 'failed', jobId, repoPath: record.path, wikiId: wikiIdFor(record.path), trigger: 'auto',
            startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), model: record.settings.model, error: { code: 'repowiki/auto-start', message: failure } },
            selection: record.settings.model ?? { provider: '', model: '' }, settings: record.settings, controller: new AbortController(), mode: 'update' })
        }
      }
    } finally { this.polling = false }
  }
  dispose(): void {
    this.disposed = true; if (this.timer) clearInterval(this.timer)
    for (const job of this.jobs.values()) if (job.status.running) {
      job.controller.abort(new WikiError('宿主已关闭，请手动恢复任务。', 'repowiki/interrupted'))
      if (job.status.stage === 'queued') { job.status.running = false; job.status.stage = 'interrupted'; void this.save(job).catch(e => this.log(String(e))) }
    }
  }
  async close(): Promise<void> {
    this.dispose()
    await this.ready
    await Promise.allSettled([...this.jobs.values()].map(j => j.settled))
    await Promise.all([...this.jobs.values()].map(j => this.save(j)))
  }
  private drain(): void {
    if (this.active || this.disposed) return
    const job = this.queue.shift(); if (!job) return
    this.active = job
    job.settled = this.run(job).catch(e => { job.status.running = false; job.status.stage = 'failed'; job.status.error = { code: 'repowiki/checkpoint', message: String(e) } })
      .finally(() => { this.active = null; this.drain() })
  }
  private async run(job: Job): Promise<void> {
    const s = job.status, signal = job.controller.signal
    const timer = job.engine === 'agent-v1' ? undefined : setTimeout(() => job.controller.abort(new WikiError('生成任务整体超时。', 'repowiki/timeout')), this.config.totalTimeoutMs)
    try {
      await this.validateModel?.(job.selection)
      if (job.engine === 'agent-v1') {
        if (!this.agentRunner) throw new WikiError('DSH 后台 Agent 服务不可用。', 'repowiki/agent-unavailable')
        await this.agentRunner(job, signal, { stateDir: this.stateDir, checkpoints: this.checkpoints, maxPageBytes: this.config.maxPageBytes, timeoutMs: this.config.pageTimeoutMs, plannerAttemptTimeoutMs: this.config.plannerAttemptTimeoutMs, jobTimeoutMs: this.config.agentJobTimeoutMs, stalledMinutes: this.config.stalledMinutes, save: () => this.save(job) })
      } else await generate(job, signal, { stateDir: this.stateDir, checkpoints: this.checkpoints, maxPageBytes: this.config.maxPageBytes,
        save: () => this.save(job), complete: prompts => this.complete(job, prompts) })
      await this.projectSettings.update(s.repoPath!, record => ({ ...record, blockedCommit: null, updateNotice: null }))
      if (job.settings.autoExport) {
        s.stage = 'export'
        try { await this.export(s.wikiId!) } catch (error) { s.warning = [s.warning, `Wiki 已保存，导出失败：${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('\n') }
      }
      s.stage = 'done'
    } catch (error) {
      if (s.result) { s.stage = 'done'; s.warning = `Wiki 已保存，后续处理失败：${error instanceof Error ? error.message : String(error)}`; return }
      const failure = signal.aborted && signal.reason instanceof WikiError ? signal.reason : error instanceof WikiError ? error : new WikiError('生成失败，请查看本机日志。', 'repowiki/failed', error)
      s.error = { code: failure.code, message: failure.message }
      s.stage = failure.code === 'repowiki/cancelled' ? 'cancelled' : failure.code === 'repowiki/paused' ? 'paused' : failure.code === 'repowiki/interrupted' ? 'interrupted' : failure.code === 'repowiki/partial' ? 'partial' : 'failed'
      this.log(`[failed] ${s.jobId} ${failure.code}: ${error instanceof Error ? error.message : String(error)}`)
      if (s.trigger === 'auto') {
        try { await this.projectSettings.update(s.repoPath!, record => ({ ...record, blockedCommit: job.commit ?? null, updateNotice: failure.message })) } catch { /* Original failure remains visible in the task. */ }
      }
    } finally {
      if (job.engine === 'agent-v1') for (const item of s.items ?? []) if (item.bodyState === 'writing') item.bodyState = item.state = 'pending'
      clearTimeout(timer); s.running = false; s.finishedAt = new Date().toISOString(); s.currentPage = null; s.processing = 0; await this.save(job) }
  }
  private complete(job: Job, prompts: { system: string; user: string }): Promise<string> {
    return completeText({ llm: this.getLlm(), selection: job.selection, sessionId: job.sessionId, ...prompts,
      signal: job.controller.signal, timeoutMs: this.config.pageTimeoutMs })
  }
}
