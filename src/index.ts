import { modelDisplay } from './shared/models.js'
import { nativeAgentRunner } from './host/agent-generation.js'
import { collaborativeRunner } from './host/collaborative.js'
/**
 * DSH 仓库维基插件 — Host 入口。
 *
 * - 服务类即 cordis 插件：注册 ctx.repowiki 服务与 Typert RPC（listProjects /
 *   startGeneration / getStatus / cancelGeneration / listWikis / readWiki / readPage）；
 * - 注册 repowiki_* 会话工具（复用同进程流水线）；
 * - 生成产物只写插件数据目录，仓库目录只读；模型复用发起会话当前选择。
 */
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'
import { WikiPipeline, type PipelineConfig } from './host/pipeline.js'
import { ReferenceRuntime } from './host/references.js'
import { applyRetention, planRetention } from './host/retention.js'
import { searchCards } from './host/cards.js'
import type { DraftResponse, ReadDraftPageRequest, ReadDraftSourceRequest, SearchDraftRequest, SearchCardsRequest, CardsResponse, ReferencesResponse, StoragePlan, StoragePruneRequest } from './shared/types.js'
import { WikiError } from './host/errors.js'
import { listProjects } from './host/projects.js'
import { registerRepoWikiTools } from './host/tools.js'
import { readPageContent, readSourceContent, wikiIdFor } from './host/store.js'
import type { ExportResponse, JobListResponse, JobRequest, ModelCapabilities, ModelSelection, ProjectConfiguration, ProjectRequest,
  ReadSourceRequest, ReadSourceResponse, SaveSettingsRequest, SearchWikiRequest, SearchWikiResponse } from './shared/types.js'
import type {
  CancelGenerationResponse,
  GenerationStatus,
  ProjectListResponse,
  ReadPageRequest,
  ReadPageResponse,
  ReadWikiRequest,
  ReadWikiResponse,
  StartGenerationRequest,
  StartGenerationResponse,
  WikiListResponse,
  WikiManifest,
} from './shared/types.js'

export type {
  ProjectEntry,
  WikiManifest,
  WikiSummary,
  GenerationStatus,
  ProjectListResponse,
  StartGenerationRequest,
  StartGenerationResponse,
  CancelGenerationResponse,
  WikiListResponse,
  ReadWikiRequest,
  ReadWikiResponse,
  ReadPageRequest,
  ReadPageResponse,
} from './shared/types.js'

declare module '@deepseek-ai/cordis' {
  interface Context { repowiki: RepoWiki }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'repowiki/failed': { reason: string }
  }
}

function defaultStateDir(): string {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-repowiki')
}

/** Host 服务，由插件 bundle 装配。 */
export default class RepoWiki extends TypertRemoteService {
  static inject = ['llm', 'typert', 'tools', 'workspaceRegistry', 'agentDefaultModel', 'agents', 'sessionPersistence', 'systemPrompt', 'sandboxPolicy']
  private readonly lifetime = new AbortController()
  readonly pipeline: WikiPipeline
  private readonly references: ReferenceRuntime

  private requireOwner(signal: AbortSignal): void {
    signal.throwIfAborted()
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('repowiki/failed', '仓库维基仅允许宿主所有者使用。', { reason: 'forbidden' })
    }
  }

  /** 面板发起生成没有会话 agent：回退到宿主默认模型（设置中选择的模型）。 */
  private defaultSelection(): { provider: string; model: string; reasoningEffort?: string } {
    const service = this.ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | undefined
    const selected = typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined
    if (!selected || typeof selected.provider !== 'string' || selected.provider.trim() === ''
      || typeof selected.model !== 'string' || selected.model.trim() === '') {
      throw new WikiError('未能获取默认模型：请先在 DSH 设置中选择可用模型。', 'repowiki/no-model')
    }
    const selection: { provider: string; model: string; reasoningEffort?: string } = { provider: selected.provider, model: selected.model }
    if (typeof selected.reasoningEffort === 'string' && selected.reasoningEffort.trim() !== '') selection.reasoningEffort = selected.reasoningEffort
    return selection
  }

  constructor(ctx: Context, config: PipelineConfig = {}) {
    super(ctx, 'repowiki')
    this.pipeline = new WikiPipeline({
      config,
      stateDir: defaultStateDir(),
      getLlm: () => ctx.llm,
      agentRunner: nativeAgentRunner(ctx, collaborativeRunner(ctx)),
      getDefaultModel: () => this.defaultSelection(),
      validateModel: async model => {
        const models = await ctx.llm.listModels(model.provider)
        if (!models.some(m => m.id === model.model)) throw new WikiError(`指定模型不可用：${model.provider}/${model.model}`, 'repowiki/model-unavailable')
        const info = await ctx.llm.resolveModelInfo(model.provider, model.model, this.lifetime.signal)
        if (model.reasoningEffort && !info.reasoning?.efforts.some(e => e.id === model.reasoningEffort)) throw new WikiError('所选模型不支持此思考强度，请重新选择。', 'repowiki/effort-unavailable')
      },
      log: line => { this.ctx.logger('dsh-repowiki').info(line) },
    })
    ctx.effect(() => registerRepoWikiTools(ctx, this.pipeline), 'dsh-repowiki:tools')
    this.references = new ReferenceRuntime(ctx, this.pipeline)
    ctx.effect(() => () => { this.lifetime.abort(); this.references.invalidate(); return this.pipeline.close() }, 'dsh-repowiki:dispose')
  }

  /** 项目总览：工作区目录 ∪ 已生成维基。 */
  @Remote
  async listProjects(signal: AbortSignal): Promise<ProjectListResponse> {
    this.requireOwner(signal)
    await this.pipeline.ready
    try {
      const projects = await listProjects(this.ctx, this.pipeline.stateDir, AbortSignal.any([signal, this.lifetime.signal]))
      const tasks = this.pipeline.statuses()
      for (const task of tasks) if (task.repoPath && !projects.some(project => wikiIdFor(project.path) === task.wikiId)) projects.push({ name: basename(task.repoPath), path: task.repoPath, wiki: null })
      for (const project of projects) project.task = tasks.find(task => task.wikiId === wikiIdFor(project.path)) ?? null
      return { projects }
    } catch (error) {
      throw this.asRemoteError(error, '项目列表读取失败。', 'list-projects')
    }
  }

  /** 启动后台生成（同一时间最多一个任务）。面板发起时使用宿主默认模型。 */
  @Remote
  async startGeneration(request: StartGenerationRequest, signal: AbortSignal): Promise<StartGenerationResponse> {
    this.requireOwner(signal)
    try {
      return await this.pipeline.start({
        repoPath: request?.path,
        mode: request.mode,
        signal: AbortSignal.any([signal, this.lifetime.signal]),
      })
    } catch (error) {
      throw this.asRemoteError(error, '生成任务启动失败。', 'start-generation')
    }
  }

  /** 当前任务进度（客户端轮询）。 */
  @Remote
  async getStatus(signal: AbortSignal): Promise<GenerationStatus> {
    this.requireOwner(signal)
    await this.pipeline.ready
    signal.throwIfAborted()
    return this.pipeline.status()
  }

  /** 取消当前生成任务。 */
  @Remote
  async cancelGeneration(signal: AbortSignal): Promise<CancelGenerationResponse> {
    this.requireOwner(signal)
    signal.throwIfAborted()
    try { return this.pipeline.cancel() }
    catch (error) { throw this.asRemoteError(error, '取消失败。', 'cancel-generation') }
  }

  /** 已生成维基清单。 */
  @Remote
  async listWikis(signal: AbortSignal): Promise<WikiListResponse> {
    this.requireOwner(signal)
    signal.throwIfAborted()
    try { return { wikis: await this.pipeline.list() } }
    catch (error) { throw this.asRemoteError(error, '维基清单读取失败。', 'list-wikis') }
  }

  /** 维基目录（含各页标题/摘要/引用数）。 */
  @Remote
  async readWiki(request: ReadWikiRequest, signal: AbortSignal): Promise<ReadWikiResponse> {
    this.requireOwner(signal)
    signal.throwIfAborted()
    try { return { wiki: await this.pipeline.readManifest(request?.wikiId) } }
    catch (error) { throw this.asRemoteError(error, '维基读取失败。', 'read-wiki') }
  }

  /** 一页维基的 Markdown 全文。 */
  @Remote
  async readPage(request: ReadPageRequest, signal: AbortSignal): Promise<ReadPageResponse> {
    this.requireOwner(signal)
    signal.throwIfAborted()
    try { return { page: await this.pipeline.readPage(request?.wikiId, request?.pageId, request?.revision) } }
    catch (error) { throw this.asRemoteError(error, '页面读取失败。', 'read-page') }
  }

  @Remote
  async getProjectConfig(request: ProjectRequest, signal: AbortSignal): Promise<ProjectConfiguration> {
    this.requireOwner(signal)
    try { return await this.pipeline.configuration(request.path, signal) }
    catch (error) { throw this.asRemoteError(error, '项目配置读取失败。', 'project-config') }
  }

  @Remote
  async saveProjectConfig(request: SaveSettingsRequest, signal: AbortSignal): Promise<ProjectConfiguration> {
    this.requireOwner(signal)
    try { return await this.pipeline.saveSettings(request.path, request.settings, signal) }
    catch (error) { throw this.asRemoteError(error, '项目配置保存失败。', 'project-config') }
    finally { this.references.invalidate() }
  }

  @Remote
  async getModelCapabilities(signal: AbortSignal): Promise<ModelCapabilities> {
    this.requireOwner(signal)
    const response: ModelCapabilities = { models: [], defaultModel: null, warnings: [] }
    try { response.defaultModel = this.defaultSelection() } catch { response.warnings.push('请先在 DSH 设置中选择默认模型。') }
    await Promise.all(this.ctx.llm.listProviders().map(async provider => {
      signal.throwIfAborted()
      try {
        const models = await this.ctx.llm.listModels(provider.id)
        const settled = await Promise.allSettled(models.map(async model => {
          const info = await this.ctx.llm.resolveModelInfo(provider.id, model.id, signal)
          const display = modelDisplay(provider.name, model.name)
          return { provider: provider.id, model: model.id, label: model.name, name: display.name, source: display.source, description: display.description,
            effortOptions: info.reasoning?.efforts.map(e => ({ id: e.id, name: e.name })) ?? [],
            efforts: info.reasoning?.efforts.map(e => e.id) ?? [] }
        }))
        signal.throwIfAborted()
        settled.forEach((result, index) => {
          if (result.status === 'fulfilled') { response.models.push(result.value); return }
          const model = models[index]!
          const display = modelDisplay(provider.name, model.name)
          response.models.push({ provider: provider.id, model: model.id, label: model.name, name: display.name, source: display.source, description: display.description, efforts: [], effortOptions: [] })
          response.warnings.push(`${provider.name}/${model.id}：思考能力暂不可用。`)
        })
      } catch { signal.throwIfAborted(); response.warnings.push(`${provider.name}：模型列表暂不可用。`) }
    }))
    return response
  }

  @Remote
  async listJobs(signal: AbortSignal): Promise<JobListResponse> {
    this.requireOwner(signal)
    await this.pipeline.ready
    return { jobs: this.pipeline.statuses() }
  }

  @Remote
  async getStoragePlan(signal: AbortSignal): Promise<StoragePlan> {
    this.requireOwner(signal)
    await this.pipeline.ready
    signal.throwIfAborted()
    return planRetention(this.pipeline.stateDir)
  }

  @Remote
  async pruneStorage(request: StoragePruneRequest, signal: AbortSignal): Promise<StoragePlan> {
    this.requireOwner(signal)
    await this.pipeline.ready
    signal.throwIfAborted()
    const plan = await planRetention(this.pipeline.stateDir, request)
    await applyRetention(this.pipeline.stateDir, plan)
    return plan
  }

  @Remote
  async getJob(request: JobRequest, signal: AbortSignal): Promise<GenerationStatus> {
    this.requireOwner(signal)
    await this.pipeline.ready
    try { return this.pipeline.status(request.jobId) } catch (error) { throw this.asRemoteError(error, '任务读取失败。', 'job') }
  }

  @Remote
  async cancelJob(request: JobRequest, signal: AbortSignal): Promise<CancelGenerationResponse> {
    this.requireOwner(signal)
    try { return this.pipeline.cancel(request.jobId) } catch (error) { throw this.asRemoteError(error, '取消失败。', 'job') }
  }

  @Remote
  async exportWiki(request: ReadWikiRequest, signal: AbortSignal): Promise<ExportResponse> {
    this.requireOwner(signal)
    try { return await this.pipeline.export(request.wikiId) } catch (error) { throw this.asRemoteError(error, '导出失败。', 'export') }
  }

  @Remote
  async readSource(request: ReadSourceRequest, signal: AbortSignal): Promise<ReadSourceResponse> {
    this.requireOwner(signal)
    try {
      const manifest = await this.pipeline.readManifest(request.wikiId)
      if (request.revision && manifest.revision !== request.revision) throw new WikiError('Wiki 版本已更新，请重新打开页面。', 'repowiki/stale-version')
      return { source: await readSourceContent(this.pipeline.stateDir, manifest, request.sourceId) }
    } catch (error) { throw this.asRemoteError(error, '引用读取失败。', 'source') }
  }

  @Remote
  async searchWiki(request: SearchWikiRequest, signal: AbortSignal): Promise<SearchWikiResponse> {
    this.requireOwner(signal)
    try {
      const wiki = await this.pipeline.readManifest(request.wikiId)
      const query = request.query.trim().slice(0, 200).toLocaleLowerCase()
      const pages = (await Promise.all(wiki.pages.map(async page => {
        signal.throwIfAborted()
        const body = await readPageContent(this.pipeline.stateDir, wiki.id, page.id, wiki) ?? ''
        const text = `${page.title}\n${page.summary}\n${body}`
        const index = text.toLocaleLowerCase().indexOf(query)
        return index >= 0 ? { id: page.id, title: page.title, snippet: text.slice(Math.max(0, index - 30), index + 130) } : null
      }))).filter((page): page is SearchWikiResponse['pages'][number] => page !== null)
      return { pages }
    } catch (error) { throw this.asRemoteError(error, '搜索失败。', 'search') }
  }

  @Remote
  async pauseJob(request: JobRequest, signal: AbortSignal): Promise<GenerationStatus> {
    this.requireOwner(signal)
    try { return await this.pipeline.pause(request.jobId) } catch (e) { throw this.asRemoteError(e, '暂停失败。', 'pause') }
  }
  @Remote
  async resumeJob(request: JobRequest, signal: AbortSignal): Promise<GenerationStatus> {
    this.requireOwner(signal)
    try { return await this.pipeline.resume(request.jobId) } catch (e) { throw this.asRemoteError(e, '恢复失败。', 'resume') }
  }
  @Remote
  async retryJob(request: JobRequest, signal: AbortSignal): Promise<GenerationStatus> {
    return this.resumeJob(request, signal)
  }
  @Remote
  async readDraft(request: JobRequest, signal: AbortSignal): Promise<DraftResponse> {
    this.requireOwner(signal)
    try { return await this.pipeline.draft(request.jobId) } catch (e) { throw this.asRemoteError(e, '草稿读取失败。', 'draft') }
  }
  @Remote
  async readDraftPage(request: ReadDraftPageRequest, signal: AbortSignal): Promise<ReadPageResponse> {
    this.requireOwner(signal)
    try { return { page: await this.pipeline.draftPage(request.jobId, request.pageId) } } catch (e) { throw this.asRemoteError(e, '草稿读取失败。', 'draft') }
  }
  @Remote
  async readDraftSource(request: ReadDraftSourceRequest, signal: AbortSignal): Promise<ReadSourceResponse> {
    this.requireOwner(signal)
    try { return { source: await this.pipeline.draftSource(request.jobId, request.sourceId) } } catch (e) { throw this.asRemoteError(e, '来源读取失败。', 'draft') }
  }
  @Remote
  async searchDraft(request: SearchDraftRequest, signal: AbortSignal): Promise<SearchWikiResponse> {
    this.requireOwner(signal)
    try { return await this.pipeline.searchDraft(request.jobId, request.query) } catch (e) { throw this.asRemoteError(e, '草稿搜索失败。', 'draft-search') }
  }
  @Remote
  async searchCards(request: SearchCardsRequest, signal: AbortSignal): Promise<CardsResponse> {
    this.requireOwner(signal)
    try {
      const wiki = await this.pipeline.readManifest(request.wikiId)
      return { cards: searchCards(wiki, request.query.slice(0, 200), request.category), revision: wiki.revision ?? null,
        enabled: (await this.pipeline.projectSettings.read(wiki.repoPath)).settings.agentReference === true }
    } catch (e) { throw this.asRemoteError(e, '卡片读取失败。', 'cards') }
  }
  @Remote
  async getReferences(request: ProjectRequest, signal: AbortSignal): Promise<ReferencesResponse> {
    this.requireOwner(signal)
    try { return await this.references.status(request.path) } catch (e) { throw this.asRemoteError(e, '引用记录读取失败。', 'references') }
  }

  private asRemoteError(error: unknown, fallback: string, stage: string): RemoteError {
    if (error instanceof RemoteError) return error
    if (error instanceof WikiError) return new RemoteError('repowiki/failed', error.message, { reason: error.code })
    this.ctx.logger('dsh-repowiki').warn(`[${stage}] ${error instanceof Error ? error.message : String(error)}`)
    return new RemoteError('repowiki/failed', fallback, { reason: stage })
  }
}
