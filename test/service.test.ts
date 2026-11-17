import assert from 'node:assert/strict'
import test from 'node:test'
import { WikiPipeline } from '../src/host/pipeline.js'
import { fakeLlm, makeRepo, PLAN_JSON, tempDir, textChunks } from './helpers.js'

function makeAgent(id = 'session-1') {
  return { id, session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }) } }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(20)
  }
  assert.ok(await predicate(), '等待条件超时')
}

test('流水线端到端：扫描→规划→逐页→落盘，可 list/read', async (t) => {
  const repo = await makeRepo(t)
  const stateDir = await tempDir(t)
  const llm = fakeLlm([
    () => textChunks(PLAN_JSON),
    () => textChunks('# 项目总览\n\n这是**总览**页。\n'),
    () => textChunks('# 架构说明\n\n- 模块 `src`\n'),
  ])
  const service = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir, getLlm: () => llm as never })

  const started = await service.start({ repoPath: repo, agent: makeAgent() })
  assert.equal(started.started, true)
  assert.match(started.wikiId, /^sample-repo-[0-9a-f]{8}$/)

  await waitFor(() => service.status().stage === 'done')
  const status = service.status()
  assert.equal(status.running, false)
  assert.equal(status.error, null)
  assert.equal(status.result?.pageCount, 2)
  assert.ok((status.result?.refs ?? 0) >= 2, '引用包括实际读取的源码及项目说明')

  const listed = await service.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.id, started.wikiId)
  assert.equal(listed[0]?.pages.length, 2)

  const manifest = await service.readManifest(started.wikiId)
  assert.equal(manifest.title, '示例仓库维基')
  const page = await service.readPage(started.wikiId, 'overview')
  assert.match(page.content, /项目总览/)

  assert.equal(llm.calls.length, 3)
  const selection = llm.calls[0]?.selection as { provider: string; model: string }
  assert.deepEqual(selection, { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(llm.calls[0]?.options?.sessionId, 'session-1')
  assert.match(llm.calls[0]?.options?.system ?? '', /资深软件架构师/)
})

test('缺少模型选择时报 repowiki/no-model，不产生后台任务', async (t) => {
  const repo = await makeRepo(t)
  const stateDir = await tempDir(t)
  const service = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir, getLlm: () => fakeLlm([]) as never })
  await assert.rejects(
    service.start({ repoPath: repo }),
    error => (error as { code: string }).code === 'repowiki/no-model',
  )
  assert.equal(service.status().stage, 'idle')
})

test('任务进行中再次 start 去重并返回同一任务，cancel 可取消', async (t) => {
  const repo = await makeRepo(t)
  const stateDir = await tempDir(t)
  const llm = fakeLlm([
    async () => new Promise(() => { /* 挂起直到被取消 */ }),
    () => textChunks(PLAN_JSON),
  ])
  const service = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir, getLlm: () => llm as never })
  const first = await service.start({ repoPath: repo, agent: makeAgent() })
  t.after(() => service.dispose())
  assert.equal(service.status().running, true)
  const second = await service.start({ repoPath: repo, agent: makeAgent() })
  assert.equal(second.started, false)
  assert.equal(second.jobId, first.jobId)

  const cancelled = service.cancel()
  assert.equal(cancelled.cancelled, true)
  await waitFor(() => service.status().running === false)
  const status = service.status()
  assert.equal(status.stage, 'cancelled')
  assert.equal(status.error?.code, 'repowiki/cancelled')
  assert.throws(() => service.cancel(), error => (error as { code: string }).code === 'repowiki/no-job')
})

test('规划输出不是合法大纲时任务失败并记录错误', async (t) => {
  const repo = await makeRepo(t)
  const stateDir = await tempDir(t)
  const llm = fakeLlm([() => textChunks('这不是 JSON')])
  const service = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir, getLlm: () => llm as never })
  await service.start({ repoPath: repo, agent: makeAgent() })
  await waitFor(() => service.status().running === false)
  const status = service.status()
  assert.equal(status.stage, 'failed')
  assert.equal(status.error?.code, 'repowiki/invalid-outline')
})

test('重新生成同一仓库覆盖内容并保留 createdAt', async (t) => {
  const repo = await makeRepo(t)
  const stateDir = await tempDir(t)
  const outline = JSON.parse(PLAN_JSON) as { pages: unknown[] }
  outline.pages = outline.pages.slice(0, 1)
  const llm = fakeLlm([
    () => textChunks(JSON.stringify(outline)),
    () => textChunks('# 总览 v1\n'),
    () => textChunks(JSON.stringify(outline)),
    () => textChunks('# 总览 v2\n'),
  ])
  const service = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir, getLlm: () => llm as never })
  await service.start({ repoPath: repo, agent: makeAgent() })
  await waitFor(() => service.status().stage === 'done')
  const first = await service.list()
  const createdAt = first[0]?.createdAt

  await service.start({ repoPath: repo, agent: makeAgent() })
  await waitFor(() => service.status().stage === 'done')
  const wikis = await service.list()
  assert.equal(wikis.length, 1, '同一路径应覆盖同一 wikiId')
  const page = await service.readPage(wikis[0]!.id, 'overview')
  assert.match(page.content, /总览 v2/)
  assert.equal(wikis[0]?.createdAt, createdAt)
})

test('dispose 中止进行中的任务', async (t) => {
  const repo = await makeRepo(t)
  const stateDir = await tempDir(t)
  const llm = fakeLlm([
    async () => new Promise(() => { /* 挂起 */ }),
    () => textChunks(PLAN_JSON),
  ])
  const service = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir, getLlm: () => llm as never })
  await service.start({ repoPath: repo, agent: makeAgent() })
  service.dispose()
  await waitFor(() => service.status().running === false)
  assert.equal(service.status().error?.code, 'repowiki/interrupted')
})
