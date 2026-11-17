import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { nativeAgentRunner } from '../src/host/agent-generation.js'
import { collaborativeRunner } from '../src/host/collaborative.js'
import { WikiPipeline } from '../src/host/pipeline.js'
import { tempDir } from './helpers.js'

type Tool = { name: string; execute: (args: unknown, exec: Record<string, unknown>) => Promise<unknown> }
type Session = { options: any; tools: Map<string, Tool> }

function fakeAgents(drive: (session: Session, prompt: string) => Promise<void>) {
  const sessions: Session[] = []
  const created: any[] = []
  return {
    ctx: { agents: {
      create: async (options: any) => {
        created.push(options)
        const tools = new Map<string, Tool>()
        let running = Promise.resolve()
        const agent = { cancel: () => {}, followup: (message: any) => { const text = message.content?.[0]?.text ?? ''; running = drive({ options, tools }, text) }, steer: () => {}, whenIdle: () => running }
        const scope = { tools: { restrict: () => {}, presentAs: () => {}, guard: () => {}, register: (tool: Tool) => tools.set(tool.name, tool) },
          systemPrompt: { section: () => {} }, on: () => {} }
        await options.setup(scope, agent)
        sessions.push({ options, tools })
        return { agent, dispose: async () => {} }
      },
      resume: async () => { throw new Error('collaborative runner must create sessions') },
    } } as unknown as Context,
    created, sessions,
  }
}

/** 单页 fixture：`extra` 追加在正文末尾，用于构造规则核验通过/不通过的两种情形。 */
async function runSinglePage(t: Parameters<typeof test>[1] extends never ? never : any, extra = '') {
  const root = await tempDir(t), stateDir = await tempDir(t)
  await writeFile(join(root, 'README.md'), '# Actual source fixture\nA small repo.\n')
  let pageSourceId = ''
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
      const read = await run('wiki_read', { path: 'README.md', startLine: 1, lines: 10 }) as { sourceId: string }
      pageSourceId = read.sourceId
      const content = `# 总览\n\n## 定位\n${'项目说明。'.repeat(120)}\n\n## 入口\n${'入口说明。'.repeat(120)}\n\n\`README.md:L1\`${extra}`
      await run('submit_page', { content, limitations: ['测试材料有限'] })
      return
    }
    if (session.tools.has('submit_verification')) {
      assert.ok(pageSourceId)
      await run('submit_verification', { supported: true, issues: [], claims: [{ claim: 'README 标题', evidence: [{ sourceId: pageSourceId, path: 'README.md', startLine: 1, endLine: 1, quote: '# Actual source fixture' }] }], review: { pass: true, relevance: true, structure: true, citations: true, issues: [] } })
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
  return { pipeline, status, agents }
}

test('规则核验通过时不启动核验子代理，仍能发布并记录核验结果', async t => {
  const { pipeline, status, agents } = await runSinglePage(t)
  assert.equal(status.stage, 'done', status.error?.message)
  assert.equal(status.result?.pageCount, 1)
  assert.deepEqual((await pipeline.draft(status.jobId!)).wiki?.readingPaths,{user:['overview'],developer:['overview'],maintainer:[]})
  assert.equal(status.quality?.pages, 1)
  assert.equal(status.quality?.verified, 1, '规则核验也应计入已核验页面')
  assert.deepEqual(agents.created.map(options => options.agentOptions.model), ['planner', 'writer'])
  assert.equal(agents.created[1]!.meta.parentSession, agents.created[0]!.sessionId)
  await pipeline.close()
})

test('出现可疑引用时回退到模型核验子代理', async t => {
  // 裸引用指向快照外的路径：不会被 commitPage 拒绝，但会被规则核验判为可疑。
  const { pipeline, status, agents } = await runSinglePage(t, '\n\n另见 missing/file.ts:10 的说明。')
  assert.equal(status.stage, 'done', status.error?.message)
  assert.equal(status.quality?.verified, 1)
  assert.deepEqual(agents.created.map(options => options.agentOptions.model), ['planner', 'writer', 'verifier'])
  await pipeline.close()
})
