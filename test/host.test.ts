/**
 * Host 契约测试：加载构建产物 lib/index.js + lib/typert.host.js，
 * 用真实 cordis Context 装配，验证服务注册、RPC fail-closed 与工具注册。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { tempDir } from './helpers.js'
import RepoWiki from '../lib/index.js'
import { TYPERT } from '../lib/typert.host.js'

interface Fixture {
  ctx: Context
  tools: { name: string }[]
}

async function fixture(t: { after: (fn: () => void) => void }): Promise<Fixture> {
  const stateDir = await tempDir(t)
  const tools: { name: string }[] = []
  const ctx = new Context()
  ctx.provide('llm', { prepareCall: async () => { throw new Error('unused') } })
  ctx.provide('sessionPersistence', {})
  ctx.provide('agents', { roots: () => [] })
  ctx.provide('sandboxPolicy', {})
  ctx.provide('systemPrompt', { context: () => () => {} })
  ctx.provide('workspaceRegistry', { list: () => [] })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'default-route', model: 'default-model' }),
  })
  ctx.provide('tools', {
    register: (definition: { name: string }) => { tools.push({ name: definition.name }); return () => {} },
  })
  // stateDir 经 env 注入（构造函数读取 DSH_HOME）。
  process.env.DSH_HOME = stateDir
  t.after(() => { delete process.env.DSH_HOME })
  return { ctx, tools }
}

test('服务以 ctx.repowiki 注册，新旧 Remote 方法经 Typert 网关暴露', async (t) => {
  const f = await fixture(t)
  const registry = f.ctx.plugin(TypertRegistry); await registry
  const unregister = f.ctx.typert.register(TYPERT)
  const fork = f.ctx.plugin(RepoWiki, {}); await fork

  assert.ok(f.ctx.repowiki, '应注册 ctx.repowiki 服务')
  const methodNames = new Set(TYPERT.invocations.map(item => item.method))
  for (const expected of ['listProjects', 'startGeneration', 'getStatus', 'cancelGeneration', 'listWikis', 'readWiki', 'readPage',
    'pauseJob', 'resumeJob', 'retryJob', 'readDraft', 'readDraftPage', 'readDraftSource', 'searchCards', 'getReferences', 'getProjectConfig', 'saveProjectConfig', 'getModelCapabilities', 'listJobs', 'getJob', 'cancelJob', 'exportWiki', 'readSource', 'searchWiki']) {
    assert.ok(methodNames.has(expected), `缺少 Remote 方法 ${expected}`)
  }

  await fork.dispose(); unregister(); await registry.dispose()
})

test('所有 RPC 在无 owner invocation 时 fail-closed', async (t) => {
  const f = await fixture(t)
  const registry = f.ctx.plugin(TypertRegistry); await registry
  const unregister = f.ctx.typert.register(TYPERT)
  const fork = f.ctx.plugin(RepoWiki, {}); await fork
  const signal = new AbortController().signal

  await assert.rejects(f.ctx.repowiki.listProjects(signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.startGeneration({ path: 'E:\\dev' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.getStatus(signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.cancelGeneration(signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.listWikis(signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.readWiki({ wikiId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.readPage({ wikiId: 'x', pageId: 'y' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.getProjectConfig({ path: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.saveProjectConfig({ path: 'x', settings: {} }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.getModelCapabilities(signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.listJobs(signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.getJob({ jobId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.cancelJob({ jobId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.exportWiki({ wikiId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.readSource({ wikiId: 'x', sourceId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.searchWiki({ wikiId: 'x', query: '' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.pauseJob({ jobId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.resumeJob({ jobId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.retryJob({ jobId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.readDraft({ jobId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.readDraftPage({ jobId: 'x', pageId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.readDraftSource({ jobId: 'x', sourceId: 'x' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.searchDraft({ jobId: 'x', query: '' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.searchCards({ wikiId: 'x', query: '' }, signal), /所有者/)
  await assert.rejects(f.ctx.repowiki.getReferences({ path: 'x' }, signal), /所有者/)

  await fork.dispose(); unregister(); await registry.dispose()
})

test('插件装配注册 4 个 repowiki_* 会话工具', async (t) => {
  const f = await fixture(t)
  f.ctx.provide('typert', {})
  const fork = f.ctx.plugin(RepoWiki, {}); await fork
  assert.deepEqual(f.tools.map(tool => tool.name),
    ['repowiki_generate', 'repowiki_status', 'repowiki_list', 'repowiki_read'])
  await fork.dispose()
})
