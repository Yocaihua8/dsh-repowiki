import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WikiPipeline } from '../src/host/pipeline.js'
import { parseCard, applyVerification } from '../src/host/cards.js'
import { eligibleAgent, ReferenceRuntime } from '../src/host/references.js'
import { readManifest, wikiIdFor } from '../src/host/store.js'
import { ProjectSettingsStore } from '../src/host/settings.js'
import { fakeLlm, makeRepo, tempDir, textChunks } from './helpers.js'

const model = { provider: 'fixture', model: 'recovery-model' }
const outline = (count: number) => JSON.stringify({ title: 'Recovery', description: '', pages: Array.from({ length: count }, (_, i) => ({ id: i ? `page-${i}` : 'overview', title: `Page ${i}`, summary: 'Source-backed page', relatedPaths: ['README.md'] })) })
async function until(predicate: () => boolean | Promise<boolean>, timeout = 6000) {
  const end = Date.now() + timeout
  while (!await predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 15))
  assert.ok(await predicate(), 'condition did not settle')
}
function pipeline(stateDir: string, llm: ReturnType<typeof fakeLlm>) { return new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir, getLlm: () => llm as never, getDefaultModel: () => model, autoPollMs: 0 }) }

test('three workers, live drafts, pause and process restart resume only unfinished pages', async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  let active = 0, peak = 0
  const blocked = async () => { peak = Math.max(peak, ++active); return await new Promise<never>(() => {}) }
  const llm = fakeLlm([() => textChunks(outline(5)), () => textChunks('# Saved page'), blocked, blocked, blocked])
  const first = pipeline(state, llm)
  t.after(() => first.close())
  const job = await first.start({ repoPath: repo })
  await until(() => first.status().pagesDone === 1 && peak === 3)
  assert.equal(peak, 3)
  assert.equal((await first.draftPage(job.jobId, 'overview')).content, '# Saved page')
  assert.equal(await readManifest(state, job.wikiId), null, 'draft never publishes early')
  await first.pause(job.jobId)
  assert.equal(first.status().stage, 'paused')
  await first.close()
  const secondLlm = fakeLlm(Array.from({ length: 4 }, () => () => textChunks('# Remaining page')))
  const second = pipeline(state, secondLlm); t.after(() => second.close())
  await second.ready
  assert.equal(second.status().stage, 'paused'); assert.equal(secondLlm.calls.length, 0, 'restart is manual')
  await second.resume(job.jobId); await until(() => !second.status().running)
  assert.equal(second.status().stage, 'done')
  assert.equal(secondLlm.calls.length, 4, 'saved outline and first page are not regenerated')
  assert.equal((await second.readPage(job.wikiId, 'overview')).content, '# Saved page')
  assert.equal((await second.readManifest(job.wikiId)).cards?.length, 5)
})

test('partial card failure retries only failed extraction and preserves published version', async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  const first = pipeline(state, fakeLlm([() => textChunks(outline(1)), () => textChunks('# Published')]))
  await first.start({ repoPath: repo }); await until(() => !first.status().running)
  const original = await first.readManifest(wikiIdFor(repo)); await first.close()
  let fail = true
  const secondLlm = fakeLlm([() => textChunks(outline(1)), () => textChunks('# New draft')], { card: options => {
    if (fail) { fail = false; return textChunks('bad card') }
    const content = options.messages![0]!.content as { type: string; text: string }[]
    const s = JSON.parse(content[0]!.text).sources[0]
    return textChunks(JSON.stringify({ title: 'Card', category: 'architecture', summary: 'Recovery facts', content: 'Recovery facts', evidence: [{ path: s.path, startLine: 1, endLine: 1, quote: s.text.split('\n')[0] }] }))
  } })
  const second = pipeline(state, secondLlm); t.after(() => second.close())
  const job = await second.start({ repoPath: repo }); await until(() => !second.status(job.jobId).running)
  assert.equal(second.status(job.jobId).stage, 'partial')
  assert.equal((await second.readManifest(job.wikiId)).revision, original.revision)
  assert.equal((await second.draftPage(job.jobId, 'overview')).content, '# New draft')
  await second.resume(job.jobId); await until(() => !second.status(job.jobId).running)
  assert.equal(second.status(job.jobId).stage, 'done'); assert.equal(secondLlm.calls.length, 2)
  assert.equal(secondLlm.auxiliaryCalls.length, 3, 'failed extraction, retry extraction, verification')
})

test('crash checkpoint is interrupted on restart; previous checkpoint repairs invalid JSON', async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  const first = pipeline(state, fakeLlm([async () => new Promise(() => {})]))
  const job = await first.start({ repoPath: repo }); await until(() => first.status().stage === 'plan')
  await first.close()
  const file = join(state, 'jobs', job.jobId, 'checkpoint.json'), raw = JSON.parse(await readFile(file, 'utf8'))
  raw.status.running = true; raw.status.stage = 'pages'
  await writeFile(join(state, 'jobs', job.jobId, 'checkpoint.previous.json'), JSON.stringify(raw))
  await writeFile(file, 'incomplete write')
  const llm = fakeLlm([]), recovered = pipeline(state, llm); t.after(() => recovered.close()); await recovered.ready
  assert.equal(recovered.status(job.jobId).stage, 'interrupted'); assert.equal(llm.calls.length, 0)
})

test('legacy settings are backed up and reference stays opt-in; new project defaults on', async t => {
  const state = await tempDir(t), repo = await makeRepo(t), settings = { language: 'zh' as const, maxPages: 3, model: null, autoExport: true, autoUpdate: false }
  const store = new ProjectSettingsStore(state, settings)
  assert.equal((await store.read(repo)).settings.agentReference, true)
  await mkdir(join(state, 'projects'))
  const file = join(state, 'projects', `${wikiIdFor(repo)}.json`), original = JSON.stringify({ path: repo, settings })
  await writeFile(file, original)
  assert.equal((await store.read(repo)).settings.agentReference, false)
  await store.update(repo, r => ({ ...r, settings: { ...r.settings, agentReference: true } }))
  assert.equal(await readFile(`${file}.pre-v3.bak`, 'utf8'), original)
  assert.equal((await store.read(repo)).settings.autoExport, true)
})

test('whole-job timeout retains drafts and a manual resume gets a fresh execution window', { timeout: 18000 }, async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  const llm = fakeLlm([() => textChunks(outline(2)), () => textChunks('# Before timeout'), async () => new Promise(() => {}), () => textChunks('# Recovered')])
  const instance = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir: state, getLlm: () => llm as never, getDefaultModel: () => model, autoPollMs: 0, config: { totalTimeoutMs: 10000 } })
  t.after(() => instance.close())
  const job = await instance.start({ repoPath: repo })
  await until(() => !instance.status().running, 13000)
  assert.equal(instance.status().error?.code, 'repowiki/timeout')
  assert.equal((await instance.draftPage(job.jobId, 'overview')).content, '# Before timeout')
  await instance.resume(job.jobId); await until(() => !instance.status().running)
  assert.equal(instance.status().stage, 'done'); assert.equal(llm.calls.length, 4)
})

test('incorrect evidence and unsupported conclusions cannot become reference cards', () => {
  const page = { id: 'overview', title: 'Page', summary: '', content: '', related: [], sources: [{ id: 'source', path: 'a.ts', startLine: 1, endLine: 2, version: 'v1', hash: 'x', text: 'export const a = 1\n' }] }
  for (const evidence of [[{ path: '../secret', startLine: 1, endLine: 1, quote: 'secret' }], [{ path: 'a.ts', startLine: 99, endLine: 99, quote: 'export const a = 1' }], [{ path: 'a.ts', startLine: 1, endLine: 1, quote: 'const a = 2' }]]) {
    const card = parseCard({ title: 'Claim', summary: '', content: 'Unfounded', evidence }, page)
    applyVerification({ supported: true, issues: [] }, card)
    assert.equal(card.verification, 'uncertain')
  }
})

test('references use only current project published cards, honor disabled setting and deny foreign sessions', async t => {
  const repo = await makeRepo(t), other = await makeRepo(t), state = await tempDir(t)
  const instance = pipeline(state, fakeLlm([() => textChunks(outline(1)), () => textChunks('# Page')], { card: options => {
    const blocks = options.messages![0]!.content as { type: string; text: string }[]
    const { sources } = JSON.parse(blocks[0]!.text)
    const metadata = sources.find((s: { path: string }) => s.path === 'package.json'), readme = sources.find((s: { path: string }) => s.path === 'README.md')
    const evidence = [metadata, metadata, metadata, readme].map(s => ({ path: s.path, startLine: 1, endLine: 1, quote: s.text.split('\n')[0] }))
    return textChunks(JSON.stringify({ title: 'Fixture', summary: 'Fixture knowledge', content: 'Fixture knowledge', evidence }))
  } }))
  t.after(() => instance.close()); const job = await instance.start({ repoPath: repo }); await until(() => !instance.status().running)
  const callbacks: Record<string, unknown> = {}
  const ctx = { systemPrompt: { context: (c: { name: string; text: unknown }) => { callbacks[c.name] = c.text } }, on: () => () => {} }
  const references = new ReferenceRuntime(ctx as never, instance)
  assert.match(await references.recall(repo, 'Fixture knowledge', 'owner'), /README.md:L1/)
  assert.equal(await references.recall(other, 'Fixture knowledge', 'owner'), '')
  await instance.saveSettings(repo, { ...(await instance.configuration(repo)).settings, agentReference: false })
  assert.equal(await references.recall(repo, 'Fixture knowledge', 'owner'), '')
  assert.equal((await references.status(repo)).records[0]?.revision, (await instance.readManifest(job.wikiId)).revision)
  const agent = { id: 'owner', session: { header: { cwd: repo }, snapshotEvents: () => [] }, ctx: { get: () => ({ resolve: () => ({ workspaceRoot: repo }) }) } }
  const access = { agents: { roots: () => [agent] }, get: () => undefined, workspaceRegistry: { list: () => [{ sessionIds: ['owner'], path: repo }] } }
  assert.equal(eligibleAgent(access as never, agent as never), true)
  agent.session.snapshotEvents = () => ['runtime-context', 'skill-catalog', 'time-context', 'model-selection'].map(kind => ({ type: 'user/message', data: { source: { kind, form: 'snapshot' } } })) as never
  assert.equal(eligibleAgent(access as never, agent as never), true, 'a previous host context snapshot must not block the next owner turn')
  agent.session.snapshotEvents = () => [{ type: 'user/message', data: { source: { kind: 'user', principal: { kind: 'remote' } } } }] as never
  assert.equal(eligibleAgent(access as never, agent as never), false)
  agent.session.snapshotEvents = () => [{ type: 'user/message', data: { source: { kind: 'external-relay' } } }] as never
  assert.equal(eligibleAgent(access as never, agent as never), false)
  agent.session.snapshotEvents = () => []
  access.workspaceRegistry.list = () => [{ sessionIds: ['owner'], path: other }]
  assert.equal(eligibleAgent(access as never, agent as never), false)
  agent.session.header = { cwd: repo, origin: 'subagent' } as never
  assert.equal(eligibleAgent(access as never, agent as never), false)
})
