import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { nativeAgentRunner } from '../src/host/agent-generation.js'
import { collaborativeRunner } from '../src/host/collaborative.js'
import { WikiPipeline } from '../src/host/pipeline.js'
import { coverageMatrix, plannerPrompt } from '../src/host/prompts.js'
import { captureSnapshot, hasWorkingTreeChanged } from '../src/host/snapshot.js'
import { tempDir } from './helpers.js'

type Tool = { name: string; execute: (args: unknown, exec: Record<string, unknown>) => Promise<unknown> }
type Session = { options: any; tools: Map<string, Tool>; hooks: Map<string, Array<(...args: any[]) => any>> }

function fakeAgents(drive: (session: Session, prompt: string) => Promise<void>) {
  const sessions: Session[] = []
  const created: any[] = []
  return {
    ctx: { agents: {
      create: async (options: any) => {
        created.push(options)
        const tools = new Map<string, Tool>()
        const hooks = new Map<string, Array<(...args: any[]) => any>>()
        let running = Promise.resolve()
        const session: Session = { options, tools, hooks }
        const agent = { cancel: () => {}, followup: (message: any) => { const text = message.content?.[0]?.text ?? ''; running = drive(session, text) }, steer: () => {}, whenIdle: () => running }
        const scope = {
          tools: { restrict: () => {}, presentAs: () => {}, guard: () => {}, register: (tool: Tool) => tools.set(tool.name, tool) },
          systemPrompt: { section: () => {} },
          on: (event: string, handler: (...args: any[]) => any) => { hooks.set(event, [...(hooks.get(event) ?? []), handler]) },
        }
        await options.setup(scope, agent)
        sessions.push(session)
        return { agent, dispose: async () => {} }
      },
      resume: async () => { throw new Error('collaborative runner must create sessions') },
    } } as unknown as Context,
    created, sessions,
  }
}

/** 单页 fixture：`extra` 追加在正文末尾，用于构造规则核验通过/不通过的两种情形。 */
async function runSinglePage(t: Parameters<typeof test>[1] extends never ? never : any, options: { extra?: string; reviewFails?: number } = {}) {
  const { extra = '', reviewFails = 0 } = options
  const root = await tempDir(t), stateDir = await tempDir(t)
  await writeFile(join(root, 'README.md'), '# Actual source fixture\nA small repo.\n')
  let pageSourceId = '', writeCount = 0, reviewCount = 0
  const agents = fakeAgents(async (session, prompt) => {
    const run = (name: string, args: unknown) => session.tools.get(name)!.execute(args, { callId: randomUUID(), signal: new AbortController().signal, concludeTurn: () => {} })
    if (session.tools.has('wiki_outline')) {
      await run('wiki_read', { path: 'README.md', startLine: 1, lines: 10 })
      await run('wiki_outline', { outline: { title: 'Fixture Wiki', description: 'Fixture', pages: [
        { id: 'overview', kind: 'page', type: 'overview', parentId: null, title: '总览', summary: '总览', sections: ['定位', '入口'], coverage: ['overview'], relatedPaths: ['README.md'] },
      ], readingPaths:{user:['overview'],developer:['overview'],maintainer:[]} }, reason: '' })
      return
    }
    if (session.tools.has('submit_page')) {
      writeCount++
      const read = await run('wiki_read', { path: 'README.md', startLine: 1, lines: 10 }) as { sourceId: string }
      pageSourceId = read.sourceId
      const content = `# 总览\n\n## 定位\n${'项目说明。'.repeat(120)}\n\n## 入口\n${'入口说明。'.repeat(120)}\n\n第 ${writeCount} 版补充说明。\`README.md:L1\`${extra}`
      await run('submit_page', { content, limitations: ['测试材料有限'] })
      return
    }
    if (session.tools.has('submit_review')) {
      reviewCount++
      assert.equal(session.tools.has('wiki_read'), false, '轻量可读性审阅不应挂载源码读取工具')
      const pass = reviewCount > reviewFails
      await run('submit_review', { pass, plainLanguage: pass, relevance: true, structure: true, citations: true, issues: pass ? [] : ['首段存在代码翻译腔，请改用自然语言说明用途'] })
      return
    }
    if (session.tools.has('submit_verification')) {
      assert.ok(pageSourceId)
      await run('submit_verification', { supported: true, issues: [], claims: [{ claim: 'README 标题', evidence: [{ sourceId: pageSourceId, path: 'README.md', startLine: 1, endLine: 1, quote: '# Actual source fixture' }] }], review: { pass: true, plainLanguage: true, relevance: true, structure: true, citations: true, issues: [] } })
      return
    }
    throw new Error(`unexpected session tools: ${[...session.tools.keys()].join(',')} (${prompt.slice(0, 80)})`)
  })
  const pipeline = new WikiPipeline({ stateDir, getLlm: () => ({}) as never, getDefaultModel: () => ({ provider: 'fake', model: 'parent' }), agentRunner: nativeAgentRunner(agents.ctx, collaborativeRunner(agents.ctx)), autoPollMs: 0 })
  const saved = await pipeline.saveSettings(root, { language: 'zh', model: null, maxPages: 32, autoUpdate: false, autoExport: false, collaboration: 'collaborative', concurrency: 1, roles: { planner: { provider: 'fake', model: 'planner' }, writer: { provider: 'fake', model: 'writer' }, verifier: { provider: 'fake', model: 'verifier' } } })
  assert.equal(saved.settings.collaboration, 'collaborative')
  const submitted = await pipeline.start({ repoPath: root })
  for (let i = 0; i < 400 && pipeline.status(submitted.jobId).running; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const status = pipeline.status(submitted.jobId)
  return { pipeline, status, agents, root, stateDir }
}

test('规则核验通过时跳过逐条 claims 核验，但仍运行轻量可读性审阅并隔离系统提示上下文', async t => {
  const { pipeline, status, agents } = await runSinglePage(t)
  assert.equal(status.stage, 'done', status.error?.message)
  assert.equal(status.result?.pageCount, 1)
  assert.deepEqual((await pipeline.draft(status.jobId!)).wiki?.readingPaths,{user:['overview'],developer:['overview'],maintainer:[]})
  assert.equal(status.quality?.pages, 1)
  assert.equal(status.quality?.verified, 1, '规则核验也应计入已核验页面')
  assert.deepEqual(agents.created.map(options => options.agentOptions.model), ['planner', 'writer', 'verifier'])
  assert.equal(agents.sessions[2]!.tools.has('submit_review'), true)
  assert.equal(agents.sessions[2]!.tools.has('submit_verification'), false)
  assert.equal(agents.created[1]!.meta.parentSession, agents.created[0]!.sessionId)
  for (const session of agents.sessions) {
    assert.ok(session.hooks.get('system-prompt/assemble')?.length, '所有协作子代理必须过滤非 repowiki 上下文')
    assert.ok(session.hooks.get('agent/request-error')?.length, '所有协作子代理必须挂载瞬态错误退避重试')
  }
  await pipeline.close()
})

test('轻量可读性审阅不通过时触发一轮修订；修订后仍不通过只记警告不阻断发布', async t => {
  const { pipeline, status, agents } = await runSinglePage(t, { reviewFails: 2 })
  assert.equal(status.stage, 'done', status.error?.message)
  assert.deepEqual(agents.created.map(options => options.agentOptions.model), ['planner', 'writer', 'verifier', 'writer', 'verifier'])
  assert.ok(status.quality?.warnings.some(w => w.includes('修订后仍有可读性建议')), '应保留修订后的可读性警告')
  await pipeline.close()
})

test('出现可疑引用时回退到模型核验子代理', async t => {
  // 裸引用指向快照外的路径：不会被 commitPage 拒绝，但会被规则核验判为可疑。
  const { pipeline, status, agents } = await runSinglePage(t, { extra: '\n\n另见 missing/file.ts:10 的说明。' })
  assert.equal(status.stage, 'done', status.error?.message)
  assert.equal(status.quality?.verified, 1)
  assert.deepEqual(agents.created.map(options => options.agentOptions.model), ['planner', 'writer', 'verifier'])
  assert.equal(agents.sessions[2]!.tools.has('submit_verification'), true)
  await pipeline.close()
})

test('恢复任务时补验已写完但未核验/未审阅的页面，不再在发布阶段失败', async t => {
  const root = await tempDir(t), stateDir = await tempDir(t)
  await writeFile(join(root, 'README.md'), '# Resume fixture\nA small repo.\n')
  let failReviewsRemaining = 2
  const agents = fakeAgents(async (session) => {
    const run = (name: string, args: unknown) => session.tools.get(name)!.execute(args, { callId: randomUUID(), signal: new AbortController().signal, concludeTurn: () => {} })
    if (session.tools.has('wiki_outline')) {
      await run('wiki_read', { path: 'README.md', startLine: 1, lines: 10 })
      await run('wiki_outline', { outline: { title: 'Resume Wiki', description: 'Resume', pages: [
        { id: 'overview', kind: 'page', type: 'overview', parentId: null, title: '总览', summary: '总览', sections: ['定位', '入口'], coverage: ['overview'], relatedPaths: ['README.md'] },
      ], readingPaths: { user: ['overview'], developer: ['overview'], maintainer: [] } }, reason: '' })
      return
    }
    if (session.tools.has('submit_page')) {
      await run('wiki_read', { path: 'README.md', startLine: 1, lines: 10 })
      const content = `# 总览\n\n## 定位\n${'项目说明。'.repeat(120)}\n\n## 入口\n${'入口说明。'.repeat(120)}\n\n\`README.md:L1\``
      await run('submit_page', { content, limitations: ['测试材料有限'] })
      return
    }
    if (session.tools.has('submit_review')) {
      if (failReviewsRemaining > 0) { failReviewsRemaining--; throw new Error('模拟审阅阶段中断') }
      await run('submit_review', { pass: true, plainLanguage: true, relevance: true, structure: true, citations: true, issues: [] })
    }
  })
  const pipeline = new WikiPipeline({ stateDir, getLlm: () => ({}) as never, getDefaultModel: () => ({ provider: 'fake', model: 'parent' }), agentRunner: nativeAgentRunner(agents.ctx, collaborativeRunner(agents.ctx)), autoPollMs: 0 })
  await pipeline.saveSettings(root, { language: 'zh', model: null, maxPages: 32, autoUpdate: false, autoExport: false, collaboration: 'collaborative', concurrency: 1, roles: {} })
  const first = await pipeline.start({ repoPath: root })
  for (let i = 0; i < 400 && pipeline.status(first.jobId).running; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(pipeline.status(first.jobId).stage, 'partial', '两轮审阅失败后任务应进入 partial 状态且保留已写页面')
  await pipeline.resume(first.jobId)
  for (let i = 0; i < 400 && pipeline.status(first.jobId).running; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(pipeline.status(first.jobId).stage, 'done', pipeline.status(first.jobId).error?.message)
  await pipeline.close()
})

test('hasWorkingTreeChanged 利用 fileStats 快速放行未变化工作区，并在文件改动时检出漂移', async t => {
  const root = await tempDir(t)
  await writeFile(join(root, 'README.md'), '# Snapshot fast check\ninitial\n')
  const signal = new AbortController().signal
  const snapshot = await captureSnapshot(root, undefined, signal, true)
  assert.ok(snapshot.fileStats?.['README.md'], '工作区快照应记录 fileStats')
  assert.equal(await hasWorkingTreeChanged(snapshot, undefined, signal), false)
  await writeFile(join(root, 'README.md'), '# Snapshot fast check\nmodified content\n')
  assert.equal(await hasWorkingTreeChanged(snapshot, undefined, signal), true)
})

test('协作模式支持增量更新：未变化页面直接复用，仅重新生成受影响页面', async t => {
  const root = await tempDir(t), stateDir = await tempDir(t)
  await writeFile(join(root, 'README.md'), '# Project A\nStable overview.\n')
  await writeFile(join(root, 'guide.md'), '# Usage Guide\nVersion 1.\n')
  await writeFile(join(root, 'options.md'), '# Options\nDefault options.\n')
  const writtenPages: string[] = []
  const agents = fakeAgents(async (session, prompt) => {
    const run = (name: string, args: unknown) => session.tools.get(name)!.execute(args, { callId: randomUUID(), signal: new AbortController().signal, concludeTurn: () => {} })
    if (session.tools.has('wiki_outline')) {
      await run('wiki_read', { path: 'README.md', startLine: 1, lines: 10 })
      await run('wiki_read', { path: 'guide.md', startLine: 1, lines: 10 })
      await run('wiki_read', { path: 'options.md', startLine: 1, lines: 10 })
      await run('wiki_outline', { outline: { title: 'Collab Update Wiki', description: 'Incremental', pages: [
        { id: 'overview', kind: 'page', type: 'overview', parentId: null, title: '总览', summary: '项目定位', sections: ['定位', '入口'], coverage: ['overview'], relatedPaths: ['README.md'] },
        { id: 'guide', kind: 'page', type: 'workflow', parentId: null, title: '使用指南', summary: '操作步骤', sections: ['步骤', '限制'], coverage: ['quickstart'], relatedPaths: ['guide.md', 'options.md'] },
      ], readingPaths: { user: ['overview', 'guide'], developer: ['overview'], maintainer: [] } }, reason: '' })
      return
    }
    if (session.tools.has('submit_page')) {
      const isGuide = prompt.includes('id=guide')
      writtenPages.push(isGuide ? 'guide' : 'overview')
      if (isGuide) {
        await run('wiki_read', { path: 'guide.md', startLine: 1, lines: 10 })
        await run('wiki_read', { path: 'options.md', startLine: 1, lines: 10 })
      } else {
        await run('wiki_read', { path: 'README.md', startLine: 1, lines: 10 })
      }
      const refs = isGuide ? '`guide.md:L1` `options.md:L1`' : '`README.md:L1`'
      const content = `# ${isGuide ? '使用指南' : '总览'}\n\n## 第一节\n${'清晰易懂的自然语言说明。'.repeat(60)}\n\n## 第二节\n${'更多操作与边界说明。'.repeat(60)}\n\n${refs}`
      await run('submit_page', { content, limitations: ['测试材料有限'] })
      return
    }
    if (session.tools.has('submit_review')) {
      await run('submit_review', { pass: true, plainLanguage: true, relevance: true, structure: true, citations: true, issues: [] })
    }
  })
  const pipeline = new WikiPipeline({ stateDir, getLlm: () => ({}) as never, getDefaultModel: () => ({ provider: 'fake', model: 'parent' }), agentRunner: nativeAgentRunner(agents.ctx, collaborativeRunner(agents.ctx)), autoPollMs: 0 })
  await pipeline.saveSettings(root, { language: 'zh', model: null, maxPages: 32, autoUpdate: false, autoExport: false, collaboration: 'collaborative', concurrency: 1, roles: { planner: { provider: 'fake', model: 'planner' }, writer: { provider: 'fake', model: 'writer' }, verifier: { provider: 'fake', model: 'verifier' } } })

  // 初次全量生成：两页都会被写入
  const initial = await pipeline.start({ repoPath: root, mode: 'generate' })
  for (let i = 0; i < 400 && pipeline.status(initial.jobId).running; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(pipeline.status(initial.jobId).stage, 'done', pipeline.status(initial.jobId).error?.message)
  assert.deepEqual(writtenPages.sort(), ['guide', 'overview'])

  // 仅修改 guide.md，启动协作增量更新：overview 应直接复用，只重写 guide
  writtenPages.length = 0
  await writeFile(join(root, 'guide.md'), '# Usage Guide\nVersion 2 with new steps.\n')
  const updated = await pipeline.start({ repoPath: root, mode: 'update' })
  for (let i = 0; i < 400 && pipeline.status(updated.jobId).running; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(pipeline.status(updated.jobId).stage, 'done', pipeline.status(updated.jobId).error?.message)
  assert.equal(pipeline.status(updated.jobId).collaboration, 'collaborative')
  assert.deepEqual(writtenPages, ['guide'], '未变化的 overview 页应直接复用，只重写受影响的 guide 页')
  await pipeline.close()
})

test('Qoder 分类覆盖矩阵过滤生成声明目录，规划提示词支持标准/深度粒度与可点击导览页', () => {
  const matrix = coverageMatrix([
    'README.md', 'package.json', 'docs/guide.md', 'docs/development.md',
    'src/index.ts', 'src/host/enhance.ts', 'src/host/auth.ts', 'src/host/errors.ts',
    'lib/types/host/enhance.d.ts', 'dist/index.js', 'test/host.test.ts', 'scripts/build.mjs',
  ])
  const allPaths = matrix.flatMap(item => item.paths)
  assert.equal(allPaths.some(p => p.startsWith('lib/types/') || p.startsWith('dist/')), false, '应过滤生成声明与构建产物目录')
  const categories = new Set(matrix.map(item => item.category))
  assert.ok(categories.has('overview') && categories.has('quickstart') && categories.has('guide') && categories.has('developer') && categories.has('security') && categories.has('troubleshooting'))
  const stdPrompt = plannerPrompt({ language: 'zh', mode: 'generate', coverage: matrix, fileCount: 12, granularity: 'standard' })
  const deepPrompt = plannerPrompt({ language: 'zh', mode: 'generate', coverage: matrix, fileCount: 12, granularity: 'deep' })
  assert.match(stdPrompt.system, /标准模式/)
  assert.match(deepPrompt.system, /深度模式/)
  assert.match(stdPrompt.system, /轻量分类导览页/)
})
