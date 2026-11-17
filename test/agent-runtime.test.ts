import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { nativeAgentRunner } from '../src/host/agent-generation.js'
import { WikiPipeline } from '../src/host/pipeline.js'
import { tempDir, fakeLlm } from './helpers.js'

type Handler = (...args: any[]) => any
function nativeFixture(drive: (events: Map<string, Handler>, controller: AbortController) => Promise<void>) {
  const events = new Map<string, Handler>(), created: any[] = [], resumed: any[] = [], tools: string[] = []
  let disposed = 0, allowed: string[] | undefined, guard: Handler | undefined
  const instantiate = async (options: any) => {
    const controller = new AbortController()
    let running = Promise.resolve()
    const agent = { cancel: () => controller.abort(), followup: () => { running = drive(events, controller) }, steer() {}, whenIdle: () => running }
    const scope = { tools: { restrict: (f: any) => { allowed = f.allow }, presentAs: (mode: string) => assert.equal(mode, 'native'), guard: (g: Handler) => { guard = g }, register: (t: any) => { tools.push(t.name) } },
      systemPrompt: { section: (p: any) => { assert.equal(p.complete, true); assert.match(p.text, /一套共享 Wiki/) } }, on: (name: string, handler: Handler) => { events.set(name, handler) } }
    await options.setup(scope, agent)
    return { agent, dispose: async () => { disposed++; controller.abort() } }
  }
  return { ctx: { agents: { create: async (o: any) => { created.push(o); return instantiate(o) }, resume: async (o: any) => { resumed.push(o); return instantiate(o) } } } as unknown as Context,
    created, resumed, tools, get disposed() { return disposed }, get allowed() { return allowed }, get guard() { return guard } }
}
async function waitFor(check: () => boolean) { for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('Timed out') }
async function fixture(t: Parameters<typeof tempDir>[0], native: ReturnType<typeof nativeFixture>) {
  const root = await tempDir(t), stateDir = await tempDir(t)
  await writeFile(join(root, 'README.md'), '# Actual source fixture\n')
  const create = () => new WikiPipeline({ stateDir, getLlm: () => fakeLlm([]) as never, getDefaultModel: () => ({ provider: 'exact-provider', model: 'x'.repeat(240), reasoningEffort: 'high' }), agentRunner: nativeAgentRunner(native.ctx), autoPollMs: 0 })
  return { root, stateDir, create }
}

test('Dedicated native Agent restricts tools, pauses after 3 no-progress rounds and resumes its persisted identity', async t => {
  const native = nativeFixture(async (events, controller) => {
    for (let n = 0; n < 5 && !controller.signal.aborted; n++) await events.get('agent/pre-step')!({}, async () => ({ kind: 'enter', messages: [] }))
  })
  const f = await fixture(t, native), pipeline = f.create(), submitted = await pipeline.start({ repoPath: f.root })
  await waitFor(() => !pipeline.status(submitted.jobId).running)
  assert.equal(pipeline.status(submitted.jobId).stage, 'paused'); assert.match(pipeline.status(submitted.jobId).error!.message, /连续三轮/)
  assert.deepEqual(native.allowed, []); assert.ok(native.guard!({ name: 'shell' })); assert.equal(native.guard!({ name: 'wiki_read' }), undefined)
  assert.ok(native.tools.includes('wiki_outline')); assert.equal(native.created[0].agentOptions.model.length, 240)
  const session = pipeline.status(submitted.jobId).agentSessionId; await pipeline.close()
  const restored = f.create(); await restored.ready
  assert.equal(native.created.length, 1); assert.equal(native.resumed.length, 0)
  await restored.resume(submitted.jobId); await waitFor(() => !restored.status(submitted.jobId).running)
  assert.equal(native.resumed[0].resumeSessionId, session); assert.equal(native.disposed, 2); await restored.close()
})

test('Pause cancels a server-directed retry wait immediately and preserves the same model', async t => {
  const native = nativeFixture(async (events, controller) => {
    await events.get('agent/request-error')!({ turn: 1, step: 1, signal: controller.signal, failure: { code: 'RATE_LIMIT', status: 429, message: 'temporarily busy', providerRetryAfterMs: 30000 } })
  })
  const f = await fixture(t, native), pipeline = f.create(), submitted = await pipeline.start({ repoPath: f.root })
  await waitFor(() => !!pipeline.status(submitted.jobId).waiting)
  assert.equal(pipeline.status(submitted.jobId).waiting!.attempt, 1)
  const started = Date.now(); await pipeline.pause(submitted.jobId)
  assert.ok(Date.now() - started < 3000); assert.equal(pipeline.status(submitted.jobId).stage, 'paused'); assert.equal(pipeline.status(submitted.jobId).waiting, undefined)
  assert.equal(native.created.length, 1); assert.equal(native.created[0].agentOptions.provider, 'exact-provider'); await pipeline.close()
})

test('Three transient recoveries are the maximum and retry exhaustion pauses', async t => {
  let attempts = 0
  const native = nativeFixture(async (events, controller) => {
    while (!controller.signal.aborted) {
      attempts++
      const action = await events.get('agent/request-error')!({ turn: 1, step: 1, signal: controller.signal, failure: { code: 'BUSY', status: 503, message: 'service busy', providerRetryAfterMs: 0 } })
      if (!action) break
    }
  })
  const f = await fixture(t, native), pipeline = f.create(), submitted = await pipeline.start({ repoPath: f.root })
  await waitFor(() => !pipeline.status(submitted.jobId).running)
  assert.equal(attempts, 4); assert.equal(pipeline.status(submitted.jobId).stage, 'paused'); await pipeline.close()
})

test('Source drift pauses before native Agent recreation and keeps checkpoint outputs intact', async t => {
  const native = nativeFixture(async (events, controller) => {
    for (let n = 0; n < 5 && !controller.signal.aborted; n++) await events.get('agent/pre-step')!({}, async () => ({ kind: 'enter', messages: [] }))
  })
  const f = await fixture(t, native), pipeline = f.create(), submitted = await pipeline.start({ repoPath: f.root })
  await waitFor(() => !pipeline.status(submitted.jobId).running)
  await writeFile(join(f.root, 'README.md'), '# Changed source\n')
  await pipeline.resume(submitted.jobId); await waitFor(() => !pipeline.status(submitted.jobId).running)
  assert.match(pipeline.status(submitted.jobId).error!.message, /源码已变化/); assert.equal(native.resumed.length, 0); await pipeline.close()
})

test('Captured real ZCode quota 429 pauses without retry or changing the configured route', async t => {
  const { failure } = JSON.parse(await readFile(new URL('./fixtures/zcode-quota-429.json', import.meta.url), 'utf8'))
  let attempts = 0
  const native = nativeFixture(async (events, controller) => {
    attempts++
    assert.equal(await events.get('agent/request-error')!({ turn: 1, step: 1, signal: controller.signal, failure }), undefined)
  })
  const f = await fixture(t, native), pipeline = f.create(), submitted = await pipeline.start({ repoPath: f.root })
  await waitFor(() => !pipeline.status(submitted.jobId).running)
  assert.equal(attempts, 1); assert.equal(pipeline.status(submitted.jobId).stage, 'paused')
  assert.match(pipeline.status(submitted.jobId).error!.message, /ZCODE_NATIVE_QUOTA_REJECTED/)
  assert.equal(pipeline.status(submitted.jobId).waiting, undefined); assert.equal(native.created.length, 1)
  await pipeline.close()
})

test('Active host shutdown persists interruption; restart is idle until manual resume and ignores legacy total deadline', async t => {
  const native = nativeFixture(async (_events, controller) => {
    await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const f = await fixture(t, native)
  const create = () => new WikiPipeline({ stateDir: f.stateDir, getLlm: () => fakeLlm([]) as never, getDefaultModel: () => ({ provider: 'exact-provider', model: 'same' }),
    config: { totalTimeoutMs: 1 }, agentRunner: nativeAgentRunner(native.ctx), autoPollMs: 0 })
  const pipeline = create(), submitted = await pipeline.start({ repoPath: f.root })
  await waitFor(() => native.created.length > 0); await new Promise(r => setTimeout(r, 30))
  assert.equal(pipeline.status(submitted.jobId).running, true)
  await pipeline.close(); assert.equal(pipeline.status(submitted.jobId).stage, 'interrupted')
  const restored = create(); await restored.ready
  assert.equal(restored.status(submitted.jobId).stage, 'interrupted'); assert.equal(native.resumed.length, 0)
  await restored.resume(submitted.jobId); await waitFor(() => native.resumed.length > 0)
  assert.equal(native.resumed[0].resumeSessionId, pipeline.status(submitted.jobId).agentSessionId)
  await restored.close()
})
