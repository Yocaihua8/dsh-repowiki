import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Checkpoint } from './checkpoints.js'
import { attachRequestRecovery, reuseUnchanged, type AgentGenerationRuntime, type AgentRunner } from './agent-generation.js'
import { AgentWorkspace, digest, recordPlannerFailure } from './agent-workspace.js'
import { captureSnapshot, asMaterial, hasWorkingTreeChanged, selectMaterial } from './snapshot.js'
import { coverageMatrix, pageWorkerPrompt, plannerPrompt, readabilityReviewPrompt, verifierPrompt } from './prompts.js'
import { aggregateQuality, type PageQuality } from './quality.js'
import { pageSubmitTool, reviewSubmitTool, snapshotTools, verificationTool } from './page-tools.js'
import { gitState } from './git.js'
import { WikiError } from './errors.js'
import { restrictToScopedToolsNatively } from './tool-scope.js'
import { readManifest, readPageContent, readSourceContent } from './store.js'
import type { CardEvidence, ModelSelection, PageReviewMeta, SourceExcerpt } from '../shared/types.js'
import { parseCitations, suspiciousCitations } from './citations.js'

const message = (text: string): UserMessage => ({ id: MessageId(randomUUID()), role: 'user', content: [{ type: 'text', text }], source: { kind: 'repowiki' } })
const roleModel = (job: Checkpoint, role: 'planner' | 'writer' | 'verifier'): ModelSelection => job.settings.roles?.[role] ?? job.selection
const agentOptions = (model: ModelSelection) => ({ ...model, reasoningEffort: model.reasoningEffort ? ReasoningEffortId(model.reasoningEffort) : undefined })
function filterRepowikiContext(scope: Parameters<AgentSetup>[0]): void {
  scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    return { ...result, contexts: result.contexts.filter(c => c.name.startsWith('repowiki-')) }
  })
}
function compactSources(content: string, sources: SourceExcerpt[], knownPaths: readonly string[]): SourceExcerpt[] {
  const ranges = new Map<string, { start: number; end: number }>()
  for (const citation of parseCitations(content, { paths: knownPaths, allowBare: true })) {
    const source = sources.find(candidate => candidate.path === citation.path && candidate.startLine <= citation.startLine && candidate.endLine >= citation.endLine)
    if (!source) continue
    const prior = ranges.get(source.id)
    ranges.set(source.id, prior ? { start: Math.min(prior.start, citation.startLine), end: Math.max(prior.end, citation.endLine) } : { start: citation.startLine, end: citation.endLine })
  }
  if (!ranges.size) for (const source of sources.slice(0, 2)) ranges.set(source.id, { start: source.startLine, end: Math.min(source.endLine, source.startLine + 60) })
  return [...ranges].slice(0, 8).map(([id, range]) => {
    const source = sources.find(candidate => candidate.id === id)!
    const start = Math.max(source.startLine, range.start - 10), end = Math.min(source.endLine, range.end + 10)
    return { ...source, startLine: start, endLine: end, text: source.text.split('\n').slice(start - source.startLine, end - source.startLine + 1).join('\n') }
  })
}
function compactEvidence(evidence: CardEvidence[], sources: SourceExcerpt[]): SourceExcerpt[] {
  const ranges = new Map<string, { start: number; end: number }>()
  for (const item of evidence) {
    const source = sources.find(candidate => candidate.id === item.sourceId) ?? sources.find(candidate => candidate.path === item.path)
    if (!source) continue
    const prior = ranges.get(source.id)
    ranges.set(source.id, prior ? { start: Math.min(prior.start, item.startLine), end: Math.max(prior.end, item.endLine) } : { start: item.startLine, end: item.endLine })
  }
  if (!ranges.size) for (const source of sources.slice(0, 2)) ranges.set(source.id, { start: source.startLine, end: Math.min(source.endLine, source.startLine + 60) })
  return [...ranges].slice(0, 6).map(([id, range]) => {
    const source = sources.find(candidate => candidate.id === id)!
    const start = Math.max(source.startLine, range.start - 10), end = Math.min(source.endLine, range.end + 10)
    return { ...source, startLine: start, endLine: end, text: source.text.split('\n').slice(start - source.startLine, end - source.startLine + 1).join('\n') }
  })
}
const serialQueue = () => {
  let tail = Promise.resolve()
  return <T>(run: () => Promise<T> | T): Promise<T> => {
    const next = tail.catch(() => {}).then(run)
    tail = next.then(() => undefined, () => undefined)
    return next
  }
}

export function collaborativeRunner(ctx: Context): AgentRunner {
  return async (job, signal, runtime) => {
    const s = job.status
    s.engine = 'agent-v1'; s.collaboration = 'collaborative'
    s.stage = 'scan'; s.currentAction = '读取源码快照'; await runtime.save()
    if (job.mode === 'update' && !job.commit) job.commit = (await gitState(s.repoPath!)).commit ?? undefined
    let fixed = await runtime.checkpoints.snapshot(s.jobId!)
    if (!fixed) {
      fixed = await captureSnapshot(s.repoPath!, job.commit, signal, true, job.settings.exclude)
      const repeated = await captureSnapshot(s.repoPath!, job.commit, signal, true, job.settings.exclude)
      if (repeated.source.fingerprint !== fixed.source.fingerprint) throw new WikiError('读取期间源码发生变化，请重新生成。', 'repowiki/paused')
      await runtime.checkpoints.saveSnapshot(s.jobId!, fixed)
    }
    const snapshot = fixed
    if (snapshot.source.fingerprint !== digest(snapshot.files.map(file => `${file.path}:${digest(file.text)}`).sort().join('\n'))
      || [...(job.agentState?.evidence ?? []), ...job.pages.flatMap(page => page.sources ?? [])].some(source => !snapshot.files.some(file => file.path === source.path && file.version === source.version
        && source.hash === digest(source.text) && file.text.split('\n').slice(source.startLine - 1, source.endLine).join('\n') === source.text))) throw new WikiError('检查点来源与固定源码快照不一致，已暂停并保留原始数据。', 'repowiki/paused')
    const previous = await readManifest(runtime.stateDir, s.wikiId!)
    if (job.mode === 'update' && previous?.source && previous.source.branch !== snapshot.source.branch) throw new WikiError('分支已切换，请重新生成。', 'repowiki/branch-changed')
    // 版本校验每次工具调用都会触发；Git 身份校验按 3s、工作区快速元信息校验按 10s 节流，
    // 与单 Agent 引擎保持一致，避免工具密集阶段反复重扫仓库。
    let lastGitCheck = 0, lastWorkingCheck = 0
    const assertVersion = async () => {
      signal.throwIfAborted()
      if (Date.now() - lastGitCheck >= 3_000) {
        lastGitCheck = Date.now()
        const current = await gitState(s.repoPath!)
        if (snapshot.source.commit && current.commit !== snapshot.source.commit || current.branch !== snapshot.source.branch) throw new WikiError('源码版本已变化，已保留当前草稿；请恢复原版本后继续，或重新生成。', 'repowiki/paused')
      }
      if (snapshot.source.kind === 'working' && Date.now() - lastWorkingCheck >= 10_000) {
        lastWorkingCheck = Date.now()
        if (await hasWorkingTreeChanged(snapshot, job.settings.exclude, signal)) throw new WikiError('工作区源码已变化，已保留当前草稿；请恢复原版本后继续，或重新生成。', 'repowiki/paused')
      }
    }
    await assertVersion()
    if (!job.agentState && previous && await reuseUnchanged(job, snapshot, previous, runtime, signal)) return
    job.agentState ??= { sessionId: `repowiki-${randomUUID()}`, sessionCreated: false, progress: 0, stalledRounds: 0, evidence: [], revisions: [], receipts: {}, verifications: {} }
    const state = job.agentState
    s.agentSessionId = state.sessionId; s.stage = job.outline ? 'pages' : 'analyze'; s.currentAction = job.outline ? '恢复未完成内容' : '分析仓库 / 规划目录'; s.waiting = undefined
    await runtime.save()
    const runController = new AbortController()
    const combined = AbortSignal.any([signal, runController.signal])
    const workspace = new AgentWorkspace(job, snapshot, runtime.stateDir, combined, runtime.save, assertVersion, runtime.maxPageBytes)
    const knownPaths = snapshot.files.map(file => file.path)
    const coverage = coverageMatrix(knownPaths)
    const serial = serialQueue()
    const qualities = new Map<string, PageQuality>()
    const failures: string[] = []
    const onAbort = () => { if (!runController.signal.aborted) runController.abort(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      if (!job.outline) {
        const plannerTools = new Set(['wiki_files', 'wiki_search', 'wiki_read', 'wiki_previous', 'wiki_outline', 'wiki_status'])
        const definitions = workspace.tools().filter(tool => plannerTools.has(tool.name))
        const planner = roleModel(job, 'planner')
        const prompts = plannerPrompt({ language: job.settings.language, mode: job.mode, coverage, fileCount: snapshot.files.length, granularity: job.settings.granularity })
        for (let attempt = 0; attempt < 2 && !job.outline; attempt++) {
          const id = SessionId(`repowiki-${randomUUID()}`)
          state.sessionId = id; state.sessionCreated = false; s.plannerSessionId = id; s.agentSessionId = id; s.currentAction = '规划目录'; await runtime.save()
          const setup: AgentSetup = (scope, agent) => {
            const names = new Set(definitions.map(tool => tool.name))
            restrictToScopedToolsNatively(scope.tools)
            scope.tools.guard(exec => names.has(exec.name) ? undefined : '规划子代理只允许只读探索和 wiki_outline。')
            definitions.forEach(tool => scope.tools.register(tool))
            scope.systemPrompt.section({ name: 'repowiki-planner', order: 0, complete: true, interpolate: false, text: prompts.system })
            filterRepowikiContext(scope)
            attachRequestRecovery(scope, {
              signal: attemptAbort.signal,
              onWait: async waiting => { s.waiting = waiting; await runtime.save() },
              onTerminal: error => { if (!attemptAbort.signal.aborted) attemptAbort.abort(error) },
            })
            scope.on('agent/request', async (_payload, next) => {
              const config = await next()
              if (config.provider !== planner.provider || config.model !== planner.model || config.reasoningEffort !== planner.reasoningEffort) throw new WikiError('规划子代理模型配置发生变化，已暂停。', 'repowiki/paused')
              return config
            })
            scope.on('agent/turn-stopping', () => { if (!job.outline) agent.steer(message('请提交完整的 wiki_outline 目录。')) })
          }
          const lastFailure = state.plannerFailures?.at(-1)
          const seed = lastFailure ? `\n\n上次目录提交被拒绝：${lastFailure.error}。请先修正该问题，再提交完整 wiki_outline。` : ''
          const attemptAbort = new AbortController()
          const forwardAbort = () => attemptAbort.abort(combined.reason)
          combined.addEventListener('abort', forwardAbort, { once: true })
          let attemptTimedOut = false
          const timer = setTimeout(() => { attemptTimedOut = true; attemptAbort.abort(new WikiError(`规划子代理第 ${attempt + 1} 轮未在时间预算内提交完整目录。`, 'repowiki/paused')) }, runtime.plannerAttemptTimeoutMs)
          timer.unref?.()
          const handle = await ctx.agents.create({ sessionId: id, agentOptions: agentOptions(planner), setup, signal: attemptAbort.signal, meta: { cwd: snapshot.root, origin: 'subagent', agentPreset: 'dsh-repowiki' } })
          try {
            handle.agent.followup(message(`${prompts.user}\n\n源码版本：${snapshot.source.fingerprint}${seed}`))
            await handle.agent.whenIdle()
            combined.throwIfAborted()
            if (attemptTimedOut) throw new WikiError(`规划子代理第 ${attempt + 1} 轮未在时间预算内提交完整目录。`, 'repowiki/paused')
          } catch (error) {
            // 单轮超时：记录失败后进入下一轮；用户取消或模型配置变更等其余错误原样上抛，不烧第二轮。
            if (!attemptTimedOut || combined.aborted) throw error
            recordPlannerFailure(job, null, error instanceof Error ? error.message : String(error))
            await runtime.save()
          } finally { clearTimeout(timer); combined.removeEventListener('abort', forwardAbort); await handle.dispose() }
        }
        if (!job.outline) {
          const finalFailure = state.plannerFailures?.at(-1)
          throw new WikiError(finalFailure ? `规划子代理未提交完整目录（${finalFailure.error}）；已保存进度，可手动继续。` : '规划子代理未提交完整目录，已保存进度；可手动继续。', 'repowiki/paused')
        }
      }
      const outline = job.outline!
      const pages = outline.pages.filter(page => page.kind !== 'group')
      // 协作模式增量更新：对关联源码与元信息均未变化的页面直接复用上一版正文与已核验状态，
      // 避免对未变化页面重复启动写作与审阅子代理。
      if (job.mode === 'update' && previous && previous.language === job.settings.language && previous.sourceIndex?.length) {
        const oldHashes = new Map(previous.sourceIndex.map(entry => [entry.path, entry.hash]))
        const newFiles = new Map(snapshot.files.map(file => [file.path, file]))
        for (const page of pages) {
          if (job.pages.some(written => written.id === page.id)) continue
          const old = previous.pages.find(entry => entry.id === page.id && entry.kind !== 'group')
          if (!old?.sources?.length) continue
          if (old.title !== page.title || old.summary !== page.summary || (old.parentId ?? null) !== (page.parentId ?? null)) continue
          const related = [...new Set([...old.related, ...page.relatedPaths])]
          if (related.some(path => !oldHashes.has(path) || oldHashes.get(path) !== newFiles.get(path)?.hash)) continue
          try {
            const rebased: SourceExcerpt[] = []
            let valid = true
            for (const ref of old.sources) {
              const source = await readSourceContent(runtime.stateDir, previous, ref.id)
              const file = newFiles.get(source.path)
              const text = file?.text.split('\n').slice(source.startLine - 1, source.endLine).join('\n')
              if (!file || text !== source.text) { valid = false; break }
              rebased.push({ ...source, version: file.version, id: digest([file.version, file.path, source.startLine, source.endLine, text]).slice(0, 32) })
            }
            if (!valid) continue
            const content = await readPageContent(runtime.stateDir, previous.id, old.id, previous)
            if (!content) continue
            const prepared = workspace.evaluatePageFor(page.id, content, rebased)
            if (prepared.quality.hard.length) continue
            await serial(async () => {
              workspace.commitPage(page.id, content, rebased, { quality: prepared.quality, allowSoft: true })
              workspace.commitRuleVerification('page', page.id)
              if (old.review?.mode === 'model') workspace.commitReview(page.id, old.review, { revised: old.review.revised })
              const item = job.status.items?.find(entry => entry.id === page.id)
              if (item) { item.state = item.bodyState = 'complete'; item.error = null }
              await runtime.save()
            })
            qualities.set(page.id, prepared.quality)
          } catch { /* 复用失败时回退到正常重新生成 */ }
        }
      }
      deadline = setTimeout(() => runController.abort(new WikiError('协作生成超过任务时限，已保存进度；可手动继续。', 'repowiki/paused')), Math.min(runtime.jobTimeoutMs, 180_000 + Math.max(1, pages.length) * 300_000))
      deadline.unref?.()

      const runPage = async (page: typeof pages[number], options: { revisionIssues?: string[]; revision?: boolean } = {}) => {
        const item = job.status.items?.find(entry => entry.id === page.id)
        const writer = roleModel(job, 'writer')
        if (item) { item.attempts = 0; item.model = writer; if (options.revision) item.reviewState = 'pending' }
        let lastError: unknown, submitted = false
        for (let attempt = 0; attempt < 2; attempt++) {
          combined.throwIfAborted()
          if (job.pages.some(written => written.id === page.id) && !options.revision) return
          if (item) { item.attempts = attempt + 1; item.state = item.bodyState = 'writing'; item.error = null; s.currentAction = `${options.revision ? '修订' : '撰写'} ${page.title}`; s.stage = 'pages'; await runtime.save() }
          const reads = new Map<string, SourceExcerpt>()
          const prompts = pageWorkerPrompt({ scan: asMaterial(snapshot, selectMaterial(snapshot, page.relatedPaths)), outline, page, language: job.settings.language, revisionIssues: options.revisionIssues })
          let softRetried = false
          const submit = async (input: { content: string; sources: SourceExcerpt[]; card?: { id?: string; title: string; category: string; summary: string; content: string; evidence: { sourceId: string; path: string; startLine: number; endLine: number; quote: string }[] }; limitations?: string[] }) => {
            const prepared = workspace.evaluatePageFor(page.id, input.content, input.sources)
            const quality = prepared.quality
            qualities.set(page.id, quality)
            if (quality.hard.length) throw new Error(`页面硬性校验失败：${quality.hard.join('；')}`)
            if (quality.soft.length && !input.limitations?.length && !softRetried) {
              softRetried = true
              throw new Error(`请按问题修订后提交（不足补充，过长或过密精简）：${quality.soft.join('；')}`)
            }
            const warnings = [...quality.soft]
            await serial(async () => {
              workspace.commitPage(page.id, input.content, input.sources, { quality, allowSoft: true })
              if (input.card) {
                try { workspace.commitCard({ ...input.card, id: input.card.id ?? `${page.id}-card`, pageId: page.id, evidence: input.card.evidence }) }
                catch (error) { warnings.push(`卡片未保存：${error instanceof Error ? error.message : String(error)}`) }
              }
              if (item) { item.model = writer; item.state = item.bodyState = 'complete'; item.error = null }
              submitted = true
              await runtime.save()
            })
            return { done: true as const, ...(warnings.length ? { warnings } : {}) }
          }
          const definitions = [...snapshotTools(snapshot, reads), pageSubmitTool(page.id, reads, submit)]
          const child = new AbortController()
          const onChildAbort = () => child.abort(combined.reason)
          combined.addEventListener('abort', onChildAbort, { once: true })
          const timer = setTimeout(() => child.abort(new WikiError('页面子代理超时，已改用下一次尝试。', 'repowiki/paused')), Math.max(runtime.timeoutMs, 15 * 60_000)); timer.unref?.()
          let childError: unknown
          const setup: AgentSetup = (scope, agent) => {
            const names = new Set(definitions.map(tool => tool.name))
            restrictToScopedToolsNatively(scope.tools)
            scope.tools.guard(exec => names.has(exec.name) ? undefined : '页面子代理只允许只读快照和 submit_page。')
            definitions.forEach(tool => scope.tools.register(tool))
            scope.systemPrompt.section({ name: 'repowiki-page', order: 0, complete: true, interpolate: false, text: prompts.system })
            filterRepowikiContext(scope)
            attachRequestRecovery(scope, {
              signal: child.signal,
              onWait: async waiting => { s.waiting = waiting; await runtime.save() },
              onTerminal: error => { childError ??= error; if (!child.signal.aborted) child.abort(error) },
            })
            scope.on('agent/request', async (_payload, next) => {
              const config = await next()
              if (config.provider !== writer.provider || config.model !== writer.model || config.reasoningEffort !== writer.reasoningEffort) throw new WikiError('页面子代理模型配置发生变化，已暂停。', 'repowiki/paused')
              return config
            })
            scope.on('agent/error', ({ error }) => { childError ??= error })
            scope.on('agent/turn-stopping', () => { if (!submitted) agent.steer(message('请完成本页并调用 submit_page。')) })
          }
          const handle = await ctx.agents.create({ sessionId: SessionId(`repowiki-${randomUUID()}`), agentOptions: agentOptions(writer), setup, signal: child.signal, meta: { cwd: snapshot.root, origin: 'subagent', parentSession: s.plannerSessionId ? SessionId(s.plannerSessionId) : undefined, delegationDepth: 1, agentPreset: 'dsh-repowiki' } })
          try {
            handle.agent.followup(message(`${prompts.user}\n\n源码版本：${snapshot.source.fingerprint}`))
            await handle.agent.whenIdle()
            child.signal.throwIfAborted()
            if (submitted) return
            lastError = childError ?? new Error('页面子代理未调用 submit_page。')
          } catch (error) { lastError = error }
          finally { clearTimeout(timer); combined.removeEventListener('abort', onChildAbort); await handle.dispose() }
        }
        if (item) { item.state = item.bodyState = 'failed'; item.error = lastError instanceof Error ? lastError.message : String(lastError); await runtime.save() }
        failures.push(`${page.id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
      }

      const pending = pages.filter(page => !job.pages.some(written => written.id === page.id))
      const concurrency = Math.max(1, Math.min(job.settings.concurrency ?? 2, 3, pending.length || 1))
      const userFacingIds = new Set([
        ...(outline.readingPaths?.user ?? []),
        ...pages.filter(p => p.type === 'overview' || p.id === 'overview' || p.type === 'quickstart' || p.type === 'guide' || p.type === 'troubleshooting').map(p => p.id),
      ])

      // 写作与核验/审阅改为页面级流水：一页写完立即进入队列，核验/审阅与后续写作并行，
      // 不再等待全部页面写完才启动。
      interface VerifyJob { kind: 'page' | 'card' | 'review'; id: string; title: string; content: string; sources: SourceExcerpt[]; readerQuestion?: string; scope?: string; summary?: string }
      const verifyJobs: VerifyJob[] = []
      const waiters: Array<() => void> = []
      let verifyCursor = 0, writersDone = false
      const wakeAll = () => { while (waiters.length) waiters.shift()!() }
      const waitForWork = () => new Promise<void>(resolve => { waiters.push(resolve) })

      const verifyOne = async (kind: 'page' | 'card', id: string, title: string, content: string, sources: SourceExcerpt[], meta: { readerQuestion?: string; scope?: string; summary?: string } = {}, revision = false): Promise<PageReviewMeta | undefined> => {
        const key = `${kind}:${id}`
        if (state.verifications[key]?.digest === digest(content)) return state.verifications[key]?.review
        const verifier = roleModel(job, 'verifier')
        const prompts = verifierPrompt({ language: job.settings.language, kind, title, content, readerQuestion: meta.readerQuestion, scope: meta.scope, summary: meta.summary, isUserFacing: kind === 'page' && userFacingIds.has(id), sources: sources.map(source => ({ sourceId: source.id, path: source.path, startLine: source.startLine, endLine: source.endLine, text: source.text })) })
        let lastError: unknown
        for (let attempt = 0; attempt < 2; attempt++) {
          combined.throwIfAborted()
          const child = new AbortController()
          const onChildAbort = () => child.abort(combined.reason)
          combined.addEventListener('abort', onChildAbort, { once: true })
          const timer = setTimeout(() => child.abort(new WikiError('核验子代理超时。', 'repowiki/paused')), Math.max(runtime.timeoutMs, 10 * 60_000)); timer.unref?.()
          let childError: unknown
          const reads = new Map<string, SourceExcerpt>()
          const definitions = [...snapshotTools(snapshot, reads), verificationTool(kind, id, async input => {
            const wanted = new Set(input.claims.flatMap(claim => claim.evidence.map(item => item.sourceId)))
            const outcome = await serial(async () => {
              const result = workspace.commitVerification(input, [...reads.values()].filter(source => wanted.has(source.id)), { revised: revision })
              await runtime.save()
              return result
            })
            return { done: true as const, review: outcome.review }
          })]
          const setup: AgentSetup = (scope, agent) => {
            const names = new Set(definitions.map(tool => tool.name))
            restrictToScopedToolsNatively(scope.tools)
            scope.tools.guard(exec => names.has(exec.name) ? undefined : '核验子代理只允许只读快照和 submit_verification。')
            definitions.forEach(tool => scope.tools.register(tool))
            scope.systemPrompt.section({ name: 'repowiki-verifier', order: 0, complete: true, interpolate: false, text: prompts.system })
            filterRepowikiContext(scope)
            attachRequestRecovery(scope, {
              signal: child.signal,
              onWait: async waiting => { s.waiting = waiting; await runtime.save() },
              onTerminal: error => { childError ??= error; if (!child.signal.aborted) child.abort(error) },
            })
            scope.on('agent/request', async (_payload, next) => {
              const config = await next()
              if (config.provider !== verifier.provider || config.model !== verifier.model || config.reasoningEffort !== verifier.reasoningEffort) throw new WikiError('核验子代理模型配置发生变化，已暂停。', 'repowiki/paused')
              return config
            })
            scope.on('agent/error', ({ error }) => { childError ??= error })
            scope.on('agent/turn-stopping', () => { if (state.verifications[key]?.digest !== digest(content)) agent.steer(message('请调用 submit_verification 提交核验。')) })
          }
          s.currentAction = `核验 ${title}`; await runtime.save()
          const handle = await ctx.agents.create({ sessionId: SessionId(`repowiki-${randomUUID()}`), agentOptions: agentOptions(verifier), setup, signal: child.signal, meta: { cwd: snapshot.root, origin: 'subagent', parentSession: s.plannerSessionId ? SessionId(s.plannerSessionId) : undefined, delegationDepth: 1, agentPreset: 'dsh-repowiki' } })
          try {
            handle.agent.followup(message(`${prompts.user}\n\n源码版本：${snapshot.source.fingerprint}`))
            await handle.agent.whenIdle()
            child.signal.throwIfAborted()
            if (state.verifications[key]?.digest === digest(content)) { lastError = undefined; break }
            lastError = childError ?? new Error('核验子代理未提交结果。')
          } catch (error) { lastError = error }
          finally { clearTimeout(timer); combined.removeEventListener('abort', onChildAbort); await handle.dispose() }
        }
        if (state.verifications[key]?.digest === digest(content)) {
          const review = state.verifications[key]?.review
          if (kind === 'page' && !revision && review && !review.pass) {
            const page = pages.find(entry => entry.id === id)
            const rewritten = job.pages.find(entry => entry.id === id)
            if (page && rewritten) {
              const before = rewritten.content
              await runPage(page, { revision: true, revisionIssues: review.issues })
              const next = job.pages.find(entry => entry.id === id)
              if (next && digest(next.content) !== digest(before)) return verifyOne(kind, id, title, next.content, next.sources ?? [], meta, true)
              await serial(async () => { workspace.commitReview(id, review, { revised: true }); await runtime.save() })
            }
          }
          return review
        }
        failures.push(`${key}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
        return undefined
      }

      /**
       * 轻量语义可读性审阅：仅在 Host 机械引用校验通过后运行，不读取源码，
       * 专注检查「是否讲人话、是否切题、结构是否好扫读、引用是否打断阅读」。
       */
      const reviewOne = async (id: string, title: string, content: string, meta: { readerQuestion?: string; scope?: string; summary?: string } = {}, revision = false): Promise<PageReviewMeta | undefined> => {
        const page = pages.find(entry => entry.id === id)
        if (!page) return undefined
        const existing = state.verifications[`page:${id}`]
        if (existing?.digest === digest(content) && existing.review?.mode === 'model') return existing.review
        const verifier = roleModel(job, 'verifier')
        const prompts = readabilityReviewPrompt({
          language: job.settings.language,
          title,
          pageType: page.type,
          isUserFacing: userFacingIds.has(id),
          content,
          readerQuestion: meta.readerQuestion,
          scope: meta.scope,
          summary: meta.summary,
        })
        let committed: PageReviewMeta | undefined
        let lastError: unknown
        for (let attempt = 0; attempt < 2 && !committed; attempt++) {
          combined.throwIfAborted()
          const child = new AbortController()
          const onChildAbort = () => child.abort(combined.reason)
          combined.addEventListener('abort', onChildAbort, { once: true })
          const timer = setTimeout(() => child.abort(new WikiError('可读性审阅子代理超时。', 'repowiki/paused')), Math.max(runtime.timeoutMs, 10 * 60_000)); timer.unref?.()
          let childError: unknown
          const definitions = [reviewSubmitTool(id, async input => {
            const outcome = await serial(async () => {
              const saved = workspace.commitReview(id, input, { revised: revision })
              await runtime.save()
              return saved
            })
            committed = outcome
            return { done: true as const, review: outcome }
          })]
          const setup: AgentSetup = (scope, agent) => {
            const names = new Set(definitions.map(tool => tool.name))
            restrictToScopedToolsNatively(scope.tools)
            scope.tools.guard(exec => names.has(exec.name) ? undefined : '可读性审阅子代理只允许调用 submit_review。')
            definitions.forEach(tool => scope.tools.register(tool))
            scope.systemPrompt.section({ name: 'repowiki-reviewer', order: 0, complete: true, interpolate: false, text: prompts.system })
            filterRepowikiContext(scope)
            attachRequestRecovery(scope, {
              signal: child.signal,
              onWait: async waiting => { s.waiting = waiting; await runtime.save() },
              onTerminal: error => { childError ??= error; if (!child.signal.aborted) child.abort(error) },
            })
            scope.on('agent/request', async (_payload, next) => {
              const config = await next()
              if (config.provider !== verifier.provider || config.model !== verifier.model || config.reasoningEffort !== verifier.reasoningEffort) throw new WikiError('审阅子代理模型配置发生变化，已暂停。', 'repowiki/paused')
              return config
            })
            scope.on('agent/error', ({ error }) => { childError ??= error })
            scope.on('agent/turn-stopping', () => { if (!committed) agent.steer(message('请调用 submit_review 提交可读性审阅结果。')) })
          }
          s.currentAction = `核验 ${title}`; await runtime.save()
          const handle = await ctx.agents.create({ sessionId: SessionId(`repowiki-${randomUUID()}`), agentOptions: agentOptions(verifier), setup, signal: child.signal, meta: { cwd: snapshot.root, origin: 'subagent', parentSession: s.plannerSessionId ? SessionId(s.plannerSessionId) : undefined, delegationDepth: 1, agentPreset: 'dsh-repowiki' } })
          try {
            handle.agent.followup(message(prompts.user))
            await handle.agent.whenIdle()
            child.signal.throwIfAborted()
            if (committed) { lastError = undefined; break }
            lastError = childError ?? new Error('可读性审阅子代理未提交结果。')
          } catch (error) { lastError = error }
          finally { clearTimeout(timer); combined.removeEventListener('abort', onChildAbort); await handle.dispose() }
        }
        if (!committed) {
          failures.push(`review:${id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
          return undefined
        }
        if (!revision && !committed.pass) {
          const rewritten = job.pages.find(entry => entry.id === id)
          if (rewritten) {
            const before = rewritten.content
            await runPage(page, { revision: true, revisionIssues: committed.issues })
            const next = job.pages.find(entry => entry.id === id)
            if (next && digest(next.content) !== digest(before)) {
              const nextQuality = qualities.get(page.id) ?? workspace.evaluatePageFor(page.id, next.content, next.sources ?? []).quality
              const nextSuspicious = suspiciousCitations(next.content, knownPaths)
              if (nextQuality.hard.length === 0 && nextSuspicious.length === 0) {
                await serial(async () => {
                  workspace.commitRuleVerification('page', page.id)
                  for (const card of job.cards.filter(entry => entry.pageId === page.id)) workspace.commitRuleVerification('card', card.id)
                  await runtime.save()
                })
                return reviewOne(id, title, next.content, meta, true)
              }
              return verifyOne('page', id, title, next.content, compactSources(next.content, next.sources ?? [], knownPaths), meta, true)
            }
            await serial(async () => { workspace.commitReview(id, committed!, { revised: true }); await runtime.save() })
          }
        }
        return committed
      }

      /**
       * 页面提交成功后立即处理核验与可读性审阅。
       *
       * 规则优先：引用可定位、无可疑引用、无硬性质量问题都成立时，
       * 机械事实由 Host 直接记入检查点（省去逐条 claims 核验开销），
       * 但仍默认进入轻量可读性审阅队列，确保「讲人话」与修订闭环生效；
       * 机械检查不通过时回退到完整模型核验。
       */
      const enqueueVerified = async (page: typeof pages[number]) => {
        const written = job.pages.find(entry => entry.id === page.id)
        if (!written) return
        const quality = qualities.get(page.id) ?? workspace.evaluatePageFor(page.id, written.content, written.sources ?? []).quality
        qualities.set(page.id, quality)
        const suspicious = suspiciousCitations(written.content, knownPaths)
        const ruleVerifiable = quality.hard.length === 0 && suspicious.length === 0
        if (ruleVerifiable) {
          try {
            await serial(async () => {
              if (state.verifications[`page:${page.id}`]?.digest !== digest(written.content)) workspace.commitRuleVerification('page', page.id)
              for (const card of job.cards.filter(entry => entry.pageId === page.id)) {
                if (state.verifications[`card:${card.id}`]?.digest !== digest(card.content)) workspace.commitRuleVerification('card', card.id)
              }
              await runtime.save()
            })
            if (state.verifications[`page:${page.id}`]?.review?.mode !== 'model') {
              verifyJobs.push({ kind: 'review', id: page.id, title: page.title, content: written.content, sources: [], readerQuestion: page.readerQuestion, scope: page.scope, summary: page.summary })
              wakeAll()
            }
            return
          } catch { /* 规则核验失败时继续走模型核验 */ }
        }
        verifyJobs.push({ kind: 'page', id: page.id, title: page.title, content: written.content, sources: compactSources(written.content, written.sources ?? [], knownPaths), readerQuestion: page.readerQuestion, scope: page.scope, summary: page.summary })
        for (const card of job.cards.filter(entry => entry.pageId === page.id)) {
          const sources = [...new Map(card.evidence.map(evidence => [evidence.sourceId, state.evidence.find(source => source.id === evidence.sourceId) ?? written.sources?.find(source => source.id === evidence.sourceId)]).filter((entry): entry is [string, SourceExcerpt] => !!entry[1])).values()]
          verifyJobs.push({ kind: 'card', id: card.id, title: card.title, content: card.content, sources: compactEvidence(card.evidence, sources) })
        }
        wakeAll()
      }

      const verifyLoop = async () => {
        for (;;) {
          if (verifyCursor < verifyJobs.length) {
            const entry = verifyJobs[verifyCursor++]!
            if (entry.kind === 'review') await reviewOne(entry.id, entry.title, entry.content, { readerQuestion: entry.readerQuestion, scope: entry.scope, summary: entry.summary })
            else await verifyOne(entry.kind, entry.id, entry.title, entry.content, entry.sources, { readerQuestion: entry.readerQuestion, scope: entry.scope, summary: entry.summary })
            continue
          }
          if (writersDone) return
          await waitForWork()
        }
      }

      // 恢复任务时补齐「已写完但尚未完成核验或语义审阅」的页面，避免 publish 时因漏验报错。
      for (const page of pages) {
        const written = job.pages.find(entry => entry.id === page.id)
        if (!written) continue
        const pageRecord = state.verifications[`page:${page.id}`]
        const needsPageCheck = pageRecord?.digest !== digest(written.content) || pageRecord.review?.mode !== 'model'
        const needsCardCheck = job.cards.some(card => card.pageId === page.id && state.verifications[`card:${card.id}`]?.digest !== digest(card.content))
        if (needsPageCheck || needsCardCheck) await enqueueVerified(page)
      }

      s.stage = pending.length ? 'pages' : 'verify'
      const verifyWorkers = Array.from({ length: Math.max(1, Math.min(concurrency, 3)) }, verifyLoop)

      let cursor = 0
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (cursor < pending.length) { const page = pending[cursor++]!; await runPage(page); await enqueueVerified(page) }
      }))
      writersDone = true; wakeAll()
      s.stage = 'verify'
      await Promise.all(verifyWorkers)
      if (failures.length) throw new WikiError(`部分页面或核验失败：${failures.join('；')}`, 'repowiki/partial')

      const quality = aggregateQuality(job.pages.map(page => ({ content: page.content, sources: page.sources ?? [], quality: qualities.get(page.id) ?? workspace.evaluatePageFor(page.id, page.content, page.sources ?? []).quality })), Object.keys(state.verifications).filter(key => key.startsWith('page:')).length, [])
      s.quality = quality
      s.stage = 'write'; s.currentAction = '发布 Wiki'
      const summary = job.cards.length ? `共 ${job.cards.length} 张卡片，覆盖已核验的页面结论。` : '本项目按实际主题组织页面，未新增独立卡片。'
      await serial(async () => { await workspace.publish(summary); await runtime.save() })
      s.stage = 'done'
    } finally {
      if (deadline) clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
      if (runController.signal.aborted && runController.signal.reason instanceof WikiError) throw runController.signal.reason
    }
  }
}
