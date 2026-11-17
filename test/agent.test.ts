import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AgentWorkspace, digest } from '../src/host/agent-workspace.js'
import { recoveryDelay, nativeAgentRunner } from '../src/host/agent-generation.js'
import { CheckpointStore, type Checkpoint } from '../src/host/checkpoints.js'
import { captureSnapshot } from '../src/host/snapshot.js'
import { validateSettings } from '../src/host/settings.js'
import { readManifest, readPageContent, wikiIdFor } from '../src/host/store.js'
import { WikiPipeline } from '../src/host/pipeline.js'
import { modelDisplay } from '../src/shared/models.js'
import { tempDir, fakeLlm } from './helpers.js'

async function fixture(t: Parameters<typeof tempDir>[0]) {
  const root = await tempDir(t), stateDir = await tempDir(t), signal = new AbortController().signal
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'main.ts'), Array.from({ length: 600 }, (_, i) => `export const value${i + 1} = ${i + 1}`).join('\n'))
  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 1')
  const snapshot = await captureSnapshot(root, undefined, signal, true), store = new CheckpointStore(stateDir)
  const job: Checkpoint = { schemaVersion: 2, engine: 'agent-v1', mode: 'generate', selection: { provider: 'fixture', model: 'fixture' }, settings: { language: 'zh', model: null, maxPages: 12, autoUpdate: false, autoExport: false }, pages: [], cards: [], verified: [],
    status: { running: true, stage: 'plan', jobId: randomUUID(), wikiId: wikiIdFor(root), repoPath: root, pagesDone: 0, pagesTotal: 0, error: null, result: null },
    agentState: { sessionId: randomUUID(), sessionCreated: false, progress: 0, stalledRounds: 0, evidence: [], revisions: [], receipts: {}, verifications: {} } }
  const workspace = new AgentWorkspace(job, snapshot, stateDir, signal, () => store.save(job), async () => {}, 32768)
  const tools = workspace.tools()
  const call = (name: string, args: unknown, callId = randomUUID()) => tools.find(t => t.name === name)!.execute(args, { callId, signal, concludeTurn() {} } as unknown as ToolRunContext) as Promise<any>
  const source = await call('wiki_read', { path: 'src/main.ts', startLine: 401, lines: 100 })
  const node = (n: number) => ({ id: `topic-${n}`, kind: 'page', parentId: 'architecture', title: `主题 ${n}`, summary: `项目主题 ${n}`, relatedPaths: ['src/main.ts'] })
  const plan = { title: '项目 Wiki', description: '源码说明', pages: [{ id: 'architecture', kind: 'group', parentId: null, title: '架构', summary: '项目架构', relatedPaths: [] }, ...Array.from({ length: 30 }, (_, i) => node(i))] }
  const evidence = { sourceId: source.sourceId, path: 'src/main.ts', startLine: 401, endLine: 401, quote: 'export const value401 = 401' }
  return { root, stateDir, snapshot, store, job, workspace, call, source, plan, evidence }
}

test('Agent reads later source pages, submits >24 complete nodes before any body; groups do not count', async t => {
  const f = await fixture(t)
  assert.equal(f.source.startLine, 401); assert.equal(f.source.endLine, 500); assert.equal(f.source.nextLine, 501); assert.equal(f.source.totalLines, 600)
  assert.deepEqual(f.source.lines[0], { line: 401, text: 'export const value401 = 401' })
  await assert.rejects(f.call('wiki_save_page', { id: 'topic-0', content: '正文', sourceIds: [f.source.sourceId] }), /先提交完整目录/)
  await f.call('wiki_outline', { outline: f.plan }); assert.equal(f.job.status.pagesTotal, 30); assert.equal(f.job.pages.length, 0)
  const pipeline = new WikiPipeline({ stateDir: f.stateDir, getLlm: () => fakeLlm([]) as never, autoPollMs: 0 }); await pipeline.ready
  assert.equal((await pipeline.draft(f.job.status.jobId!)).wiki?.pages.length, 31)
  await pipeline.close()
  await f.call('wiki_save_page', { id: 'topic-0', content: '# 主题\n`src/main.ts:L401`', sourceIds: [f.source.sourceId] })
  assert.equal(f.job.status.items![0]!.bodyState, 'complete'); assert.equal(f.job.status.items![0]!.verificationState, 'pending'); assert.equal(f.job.cards.length, 0)
})

test('new tasks require reading paths while old checkpoints keep their optional contract', async t => {
  const f = await fixture(t)
  f.job.readingPlanRequired = true
  await assert.rejects(f.call('wiki_outline', {outline:f.plan}), /新任务必须提交 readingPaths/)
  const readingPaths = {user:['topic-0'],developer:['topic-0','topic-1'],maintainer:[]}
  await f.call('wiki_outline', {outline:{...f.plan,readingPaths}})
  const restored = (await f.store.list()).find(job => job.status.jobId === f.job.status.jobId)
  assert.equal(restored?.readingPlanRequired,true)
  assert.deepEqual(restored?.outline?.readingPaths,readingPaths)
})

test('Agent guards paths, cycles, duplicate IDs, invented citations, stable outline IDs and revision reasons', async t => {
  const f = await fixture(t)
  await assert.rejects(f.call('wiki_read', { path: '../outside.txt' }), /只读快照/)
  await assert.rejects(f.call('wiki_outline', { outline: { ...f.plan, pages: [f.plan.pages[1], f.plan.pages[1]] } }), /标识唯一/)
  await assert.rejects(f.call('wiki_outline', { outline: { ...f.plan, pages: [{ ...f.plan.pages[1], parentId: 'topic-0' }] } }), /循环/)
  await f.call('wiki_outline', { outline: f.plan })
  await assert.rejects(f.call('wiki_save_page', { id: 'topic-0', content: '`src/main.ts:L1`', sourceIds: [f.source.sourceId] }), /未被任何已读片段覆盖/)
  await assert.rejects(f.call('wiki_outline', { outline: { ...f.plan, title: '新标题' } }), /原因/)
  await assert.rejects(f.call('wiki_outline', { outline: { ...f.plan, pages: f.plan.pages.slice(0, 2) }, reason: '缩减' }), /不能移除/)
  await f.call('wiki_outline', { outline: { ...f.plan, title: '新标题' }, reason: '补充说明标题' })
  assert.equal(f.job.agentState!.revisions.length, 2)
})

test('Outline identifiers are normalized with hints; publish rejects duplicate cards and ghost page links', async t => {
  const f = await fixture(t)
  const plan = { title: '测试 Wiki', description: '测试', pages: [{ id: 'Bad.Page', kind: 'page' as const, parentId: null, title: '测试页', summary: '测试页', relatedPaths: ['src/main.ts'] }] }
  const outlined = await f.call('wiki_outline', { outline: plan })
  assert.match(outlined.hints?.[0] ?? '', /Bad\.Page.*bad-page/)
  assert.equal(f.job.outline!.pages[0]!.id, 'bad-page')
  await f.call('wiki_save_page', { id: 'bad-page', content: '# 测试\n`src/main.ts:L401`', sourceIds: [f.source.sourceId] })
  f.job.cards.push({ id: 'same', pageId: 'bad-page', title: '一', category: 'api', summary: '一', content: '一', evidence: [f.evidence], verification: 'uncertain', issues: [], version: 'v' })
  f.job.cards.push({ id: 'same', pageId: 'bad-page', title: '二', category: 'api', summary: '二', content: '二', evidence: [f.evidence], verification: 'uncertain', issues: [], version: 'v' })
  await assert.rejects(f.call('wiki_publish', { cardSummary: '测试卡片。' }), /卡片标识重复/)
  f.job.cards[1]!.id = 'other'; f.job.cards[1]!.pageId = 'ghost'
  await assert.rejects(f.call('wiki_publish', { cardSummary: '测试卡片。' }), /卡片关联页面不存在/)
})

test('Host validates all planned pages and independently verified cards; tools replay exactly after checkpoint', async t => {
  const f = await fixture(t)
  const plan = { ...f.plan, pages: f.plan.pages.slice(0, 2) }
  await f.call('wiki_outline', { outline: plan })
  await assert.rejects(f.call('wiki_publish', { cardSummary: '此项目按实际知识价值整理。' }), /未完成/)
  const args = { id: 'topic-0', content: '# value401\n值为 401。`src/main.ts:L401`', sourceIds: [f.source.sourceId] }, callId = randomUUID()
  await f.call('wiki_save_page', args, callId)
  const progress = f.job.agentState!.progress
  await f.call('wiki_save_page', args, callId); assert.equal(f.job.agentState!.progress, progress)
  await assert.rejects(f.call('wiki_save_page', { ...args, content: '不同正文' }, callId), /标识冲突/)
  for (const id of ['value-contract', 'value-api']) await f.call('wiki_save_card', { id, pageId: 'topic-0', title: id, category: 'api', summary: 'value401 为 401', content: '导出 value401 常量。', evidence: [f.evidence] })
  assert.equal(f.job.cards.length, 2)
  await assert.rejects(f.call('wiki_verify', { kind: 'page', id: 'topic-0', supported: true, issues: [], claims: [{ claim: 'value401', evidence: [{ ...f.evidence, quote: 'invented' }] }] }), /原文/)
  const verify = { supported: true, issues: [], claims: [{ claim: 'value401 为 401', evidence: [f.evidence] }] }
  await f.call('wiki_verify', { ...verify, kind: 'page', id: 'topic-0' })
  await assert.rejects(f.call('wiki_publish', { cardSummary: '此项目按实际知识价值整理。' }), /card:/)
  for (const id of ['value-contract', 'value-api']) await f.call('wiki_verify', { ...verify, kind: 'card', id })
  await f.call('wiki_publish', { cardSummary: '两张卡片关联同一页面的不同知识点。' })
  const saved = await readManifest(f.stateDir, f.job.status.wikiId!)
  assert.equal(saved!.pages.length, 2); assert.equal(f.job.status.result!.pageCount, 1)
  assert.equal(await readPageContent(f.stateDir, saved!.id, 'architecture'), null)
  assert.match((await readPageContent(f.stateDir, saved!.id, 'topic-0'))!, /401/)
  assert.equal((await f.store.list())[0]!.agentState!.receipts[callId]!.digest, digest({ name: 'wiki_save_page', args }))
})

test('wiki_verify accepts claims wrapped in a JSON string from tool-calling models', async t => {
  const f = await fixture(t); await f.call('wiki_outline', { outline: { ...f.plan, pages: f.plan.pages.slice(0, 2) } })
  await f.call('wiki_save_page', { id: 'topic-0', content: '# value401\n`src/main.ts:L401`', sourceIds: [f.source.sourceId] })
  const claims = [{ claim: 'value401 为 401', evidence: [f.evidence] }]
  const result = await f.call('wiki_verify', { kind: 'page', id: 'topic-0', supported: true, issues: [], claims: JSON.stringify(claims) })
  assert.equal(result.verification, 'supported')
  assert.equal(f.job.status.items![0]!.verificationState, 'supported')
  assert.equal(f.job.agentState!.verifications['page:topic-0']!.claims.length, 1)
  // Qoder Auto wrapped claims in a string and left Chinese quotes unescaped.
  const malformed = JSON.stringify(claims).replace('value401 为 401', '"value401" 为 401')
  const repaired = await f.call('wiki_verify', { kind: 'page', id: 'topic-0', supported: true, issues: [], claims: malformed })
  assert.equal(repaired.verification, 'supported')
  assert.equal(f.job.agentState!.verifications['page:topic-0']!.claims[0]!.claim, '"value401" 为 401')
})

test('Verifier evidence accepts a re-read source and corrects a quote to its actual line', async t => {
  const f = await fixture(t); await f.call('wiki_outline', { outline: { ...f.plan, pages: f.plan.pages.slice(0, 2) } })
  await f.call('wiki_save_page', { id: 'topic-0', content: '# value402\n`src/main.ts:L402`', sourceIds: [f.source.sourceId] })
  const reread = { ...f.source, id: 'a'.repeat(32), startLine: 402, endLine: 402, text: 'export const value402 = 402' }
  f.workspace.commitVerification({ kind: 'page', id: 'topic-0', supported: true, issues: [], claims: [{ claim: 'value402 为 402', evidence: [{ sourceId: reread.id, path: 'src/main.ts', startLine: 401, endLine: 401, quote: 'export const value402 = 402' }] }] }, [reread])
  assert.equal(f.job.status.items![0]!.verificationState, 'supported')
  assert.equal(f.job.agentState!.verifications['page:topic-0']!.claims[0]!.evidence[0]!.startLine, 402)
  f.workspace.commitVerification({ kind: 'page', id: 'topic-0', supported: true, issues: [], claims: [{ claim: 'value402 为 402', evidence: [{ sourceId: reread.id, path: 'src/main.ts', startLine: 402, endLine: 402 }] }] }, [reread])
  assert.equal(f.job.agentState!.verifications['page:topic-0']!.claims[0]!.evidence[0]!.quote, 'export const value402 = 402')
})

test('Uncertain claims stay in metadata and do not mutate the page body', async t => {
  const f = await fixture(t); await f.call('wiki_outline', { outline: { ...f.plan, pages: f.plan.pages.slice(0, 2) } })
  await f.call('wiki_save_page', { id: 'topic-0', content: '# 页面', sourceIds: [f.source.sourceId] })
  await f.call('wiki_verify', { kind: 'page', id: 'topic-0', supported: false, issues: ['性能结论缺少依据'], claims: [{ claim: '导出常量', evidence: [f.evidence] }] })
  assert.equal(f.job.pages[0]!.content, '# 页面')
  assert.equal(f.job.pages[0]!.verification, 'uncertain')
  assert.deepEqual(f.job.pages[0]!.verificationIssues, ['性能结论缺少依据'])
  assert.equal(f.job.status.items![0]!.bodyState, 'complete')
})

test('verification review is stored as metadata and never appended to the page body', async t => {
  const f = await fixture(t)
  await f.call('wiki_outline', { outline: { ...f.plan, pages: f.plan.pages.slice(0, 2) } })
  await f.call('wiki_save_page', { id: 'topic-0', content: '# 页面', sourceIds: [f.source.sourceId] })
  const review = { pass: false, relevance: false, structure: true, citations: true, issues: ['开头缺少结论'] }
  await f.call('wiki_verify', { kind: 'page', id: 'topic-0', supported: true, issues: [], claims: [{ claim: '导出常量', evidence: [f.evidence] }], review })
  assert.equal(f.job.pages[0]!.content, '# 页面')
  assert.equal(f.job.pages[0]!.verification, 'supported')
  assert.equal(f.job.pages[0]!.review?.pass, false)
  assert.equal(f.job.status.items![0]!.reviewState, 'revise')
})

test('enforced quality gate rejects short pages, then allows one soft retry for a compliant save', async t => {
  const f = await fixture(t)
  f.job.qualityPolicy = 'enforce'
  await f.call('wiki_outline', { outline: { ...f.plan, pages: f.plan.pages.slice(0, 2) } })
  await assert.rejects(f.call('wiki_save_page', { id: 'topic-0', content: '# 页面', sourceIds: [f.source.sourceId] }), /页面质量硬性失败/)
  const other = await f.call('wiki_read', { path: 'src/other.ts', startLine: 1, lines: 10 })
  const body = `# 主题\n\n${'说明。'.repeat(160)}\n\n## 背景\n\n${'背景。'.repeat(160)}\n\n## 结论\n\n\`src/main.ts:L401\` 与 \`src/other.ts:L1\`。`
  const args = { id: 'topic-0', content: body, sourceIds: [f.source.sourceId, other.sourceId] }
  await assert.rejects(f.call('wiki_save_page', args), /页面可读性检查未通过/)
  await f.call('wiki_save_page', args)
  assert.deepEqual(f.job.pages[0]!.quality?.hard, [])
  assert.equal(f.job.status.items![0]!.qualityState, 'warn')
})

test('Bounded recovery honors server waits and distinguishes hard quota/auth errors', () => {
  const transient = { code: 'RATE_LIMIT', message: 'service busy', status: 429 }
  assert.deepEqual([0, 1, 2, 3].map(n => recoveryDelay(transient, n)), [30000, 60000, 120000, null])
  assert.equal(recoveryDelay({ ...transient, providerRetryAfterMs: 1234 }, 1), 1234)
  assert.equal(recoveryDelay({ code: 'ZCODE_NATIVE_QUOTA_REJECTED', message: 'quota exhausted', status: 429 }, 0), null)
  assert.equal(recoveryDelay({ code: 'AUTH', message: 'expired', status: 401 }, 0), null)
  assert.equal(recoveryDelay({ code: 'ECONNRESET', message: 'network interrupted' }, 0), 30000)
})

test('Collaborative settings validate role models and concurrency; legacy settings default collaborative', () => {
  const base = { language: 'zh' as const, model: null, maxPages: 64, autoUpdate: false, autoExport: false }
  const settings = validateSettings({ ...base, collaboration: 'collaborative', concurrency: 2, roles: { planner: { provider: 'p', model: 'plan' }, writer: { provider: 'p', model: 'write' }, verifier: null } })
  assert.equal(settings.collaboration, 'collaborative'); assert.equal(settings.concurrency, 2)
  assert.equal(settings.roles.writer!.model, 'write'); assert.equal(settings.roles.verifier, null)
  assert.equal(validateSettings(base).collaboration, 'collaborative'); assert.equal(validateSettings(base).concurrency, 2)
  assert.throws(() => validateSettings({ ...base, collaboration: 'invalid' as never }))
  assert.throws(() => validateSettings({ ...base, concurrency: 4 as never }))
  assert.throws(() => validateSettings({ ...base, roles: { writer: { provider: '', model: 'x' } } }))
  assert.throws(() => validateSettings({ ...base, maxPages: 65 }))
})

test('Opaque model IDs up to 4096 persist intact and readable labels do not repeat routing prefixes', () => {
  const settings = { language: 'zh' as const, model: { provider: 'connect-router-zcode', model: 'g'.repeat(4096) }, maxPages: 12, autoUpdate: false, autoExport: false }
  assert.equal(validateSettings(settings).model!.model, settings.model.model)
  assert.throws(() => validateSettings({ ...settings, model: { ...settings.model, model: 'x'.repeat(4097) } }))
  assert.deepEqual(modelDisplay('Connect Router · ZCode', 'Connect Router · ZCode · GLM-5.3-Flash · BigModel · 个人 Coding Plan'), { name: 'GLM-5.3-Flash', source: 'ZCode', description: 'BigModel · 个人 Coding Plan' })
})


test('Only an identical source range is no progress; a precise verification excerpt is saved once', async t => {
  const f = await fixture(t), before = f.job.agentState!.progress
  await f.call('wiki_read', { path: 'src/main.ts', startLine: 401, lines: 100 })
  assert.equal(f.job.agentState!.progress, before)
  await f.call('wiki_read', { path: 'src/main.ts', startLine: 401, lines: 1 })
  assert.equal(f.job.agentState!.progress, before + 1)
  await f.call('wiki_read', { path: 'src/main.ts', startLine: 401, lines: 1 })
  assert.equal(f.job.agentState!.progress, before + 1)
})

test('Native tool schemas describe input defaults as optional, matching the execution parser', async t => {
  const f = await fixture(t), tool = f.workspace.tools().find(t => t.name === 'wiki_read')!
  assert.deepEqual((tool.parameters as { required: string[] }).required, ['path'])
  const result = await f.call('wiki_read', { path: 'src/main.ts' })
  assert.equal(result.startLine, 1); assert.equal(result.endLine, 160)
})

test('Agent incremental reuse checks unchanged files and rebases sources; unchanged update makes zero model calls', async t => {
  const f = await fixture(t), plan = { ...f.plan, pages: f.plan.pages.slice(0, 2) }
  await f.call('wiki_outline', { outline: plan })
  await f.call('wiki_save_page', { id: 'topic-0', content: '# Exact saved body', sourceIds: [f.source.sourceId] })
  await f.call('wiki_verify', { kind: 'page', id: 'topic-0', supported: true, issues: [], claims: [{ claim: '导出 401', evidence: [f.evidence] }] })
  await f.call('wiki_publish', { cardSummary: '单一常量示例没有额外独立知识点。' })
  const original = await readManifest(f.stateDir, f.job.status.wikiId!)
  const fresh = (): Checkpoint => ({ ...structuredClone(f.job), mode: 'update' as const, agentState: undefined, pages: [], cards: [], verified: [], outline: undefined,
    status: { ...f.job.status, running: true, jobId: randomUUID(), result: null, items: [], pagesDone: 0, pagesTotal: 0 } })
  const unchanged = fresh(), runner = nativeAgentRunner({ agents: { create() { assert.fail('No model needed') }, resume() { assert.fail('No model needed') } } } as never)
  await runner(unchanged, new AbortController().signal, { stateDir: f.stateDir, checkpoints: f.store, maxPageBytes: 32768, timeoutMs: 1000, save: () => f.store.save(unchanged) })
  assert.equal(unchanged.status.result!.pageCount, 1)
  assert.equal(await readPageContent(f.stateDir, original!.id, 'topic-0'), '# Exact saved body')
  await writeFile(join(f.root, 'src', 'other.ts'), 'export const other = 2')
  const snapshot = await captureSnapshot(f.root, undefined, new AbortController().signal, true), job = fresh()
  job.agentState = { ...structuredClone(f.job.agentState!), evidence: [], receipts: {}, revisions: [], verifications: {} }
  const w = new AgentWorkspace(job, snapshot, f.stateDir, new AbortController().signal, async () => {}, async () => {}, 32768)
  const call = (name: string, args: unknown) => w.tools().find(t => t.name === name)!.execute(args, { callId: randomUUID(), signal: new AbortController().signal, concludeTurn() {} } as unknown as ToolRunContext) as Promise<any>
  await call('wiki_read', { path: 'src/main.ts', startLine: 401, lines: 1 }); await call('wiki_outline', { outline: plan })
  await call('wiki_reuse_page', { id: 'topic-0' })
  assert.equal(job.pages[0]!.content, '# Exact saved body'); assert.equal(job.pages[0]!.sources![0]!.version, snapshot.files[0]!.version)
  snapshot.files.find(s => s.path === 'src/main.ts')!.hash = 'changed'
  await assert.rejects(call('wiki_reuse_page', { id: 'topic-0' }), /源码有变化/)
})

test('A page citing an already-read range succeeds and Host merges the covering excerpt into sources', async t => {
  const f = await fixture(t); await f.call('wiki_outline', { outline: f.plan })
  const next = await f.call('wiki_read', { path: 'src/main.ts', startLine: 501, lines: 100 })
  f.job.agentState!.stalledRounds = 2
  const before = f.job.agentState!.progress
  await f.call('wiki_save_page', { id: 'topic-0', content: '# 主题\n`src/main.ts:L550`', sourceIds: [f.source.sourceId] })
  assert.deepEqual(f.job.pages[0]!.sources!.map(s => s.id), [f.source.sourceId, next.sourceId])
  assert.deepEqual(f.job.pages[0]!.related, ['src/main.ts'])
  assert.equal(f.job.agentState!.progress, before + 1)
  assert.equal(f.job.agentState!.stalledRounds, 0)
  assert.equal(f.job.status.items![0]!.bodyState, 'complete')
  assert.equal(f.job.status.items![0]!.error, null)
})

test('Union coverage spans adjacent excerpts; resubmitting with explicit ids is unchanged', async t => {
  const f = await fixture(t); await f.call('wiki_outline', { outline: f.plan })
  const next = await f.call('wiki_read', { path: 'src/main.ts', startLine: 501, lines: 100 })
  const content = '# 主题\n`src/main.ts:L450-L550`'
  await f.call('wiki_save_page', { id: 'topic-0', content, sourceIds: [f.source.sourceId] })
  assert.deepEqual(f.job.pages[0]!.sources!.map(s => s.id), [f.source.sourceId, next.sourceId])
  const progress = f.job.agentState!.progress
  const result = await f.call('wiki_save_page', { id: 'topic-0', content, sourceIds: [f.source.sourceId, next.sourceId] })
  assert.equal(result.unchanged, true)
  assert.equal(f.job.agentState!.progress, progress)
})

test('An uncovered span is rejected with token, path and read-range hints', async t => {
  const f = await fixture(t); await f.call('wiki_outline', { outline: f.plan })
  await f.call('wiki_read', { path: 'src/main.ts', startLine: 1, lines: 100 })
  await f.call('wiki_read', { path: 'src/main.ts', startLine: 200, lines: 51 })
  await assert.rejects(f.call('wiki_save_page', { id: 'topic-0', content: '`src/main.ts:L90-L210`', sourceIds: [f.source.sourceId] }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /未被任何已读片段覆盖/)
    assert.match(error.message, /src\/main\.ts:L90-L210/)
    assert.match(error.message, /L1-L100/)
    assert.match(error.message, /L200-L250/)
    return true
  })
  assert.equal(f.job.status.items![0]!.state, 'failed')
  assert.match(f.job.status.items![0]!.error!, /src\/main\.ts:L90-L210/)
})

test('Card evidence can span adjacent reads; unknown bare citations only warn', async t => {
  const f = await fixture(t); await f.call('wiki_outline', { outline: f.plan })
  await f.call('wiki_save_page', { id: 'topic-0', content: '# 主题\n`src/main.ts:L401`', sourceIds: [f.source.sourceId] })
  await f.call('wiki_read', { path: 'src/main.ts', startLine: 1, lines: 10 })
  const second = await f.call('wiki_read', { path: 'src/main.ts', startLine: 11, lines: 10 })
  const quote = Array.from({ length: 13 }, (_, i) => `export const value${i + 1} = ${i + 1}`).slice(7).join('\n')
  await f.call('wiki_save_card', { id: 'adjacent', pageId: 'topic-0', title: '相邻读取', category: 'api', summary: '相邻读取', content: '相邻读取', evidence: [{ sourceId: second.sourceId, path: 'src/main.ts', startLine: 8, endLine: 13, quote }] })
  assert.equal(f.job.cards.length, 1)
  const result = await f.call('wiki_save_page', { id: 'topic-0', content: '# 主题\n`src/main.ts:L401`\nunknown.ts:9', sourceIds: [f.source.sourceId] })
  assert.deepEqual(result.warnings, ['unknown.ts:9'])
})

test('Unread and missing paths are distinguished; problem list is bounded', async t => {
  const f = await fixture(t); await f.call('wiki_outline', { outline: f.plan })
  const content = ['`src/other.ts:L1`', '`src/ghost.ts:L3`', '`src/main.ts:L1`', '`src/main.ts:L700`', '`src/main.ts:L800`', '`src/main.ts:L900`'].join(' ')
  let message = ''
  await assert.rejects(f.call('wiki_save_page', { id: 'topic-0', content, sourceIds: [f.source.sourceId] }), (error: unknown) => {
    assert.ok(error instanceof Error)
    message = error.message
    assert.match(message, /该路径尚未读取/)
    assert.match(message, /不在项目快照中/)
    assert.match(message, /另有 2 处/)
    return true
  })
  assert.ok(message.length < 1200)
})

test('collaborative outlines do not impose group or page quotas', async t => {
  const f = await fixture(t); f.job.settings.collaboration = 'collaborative'
  const pages = Array.from({ length: 10 }, (_, i) => ({ id: `flat-${i}`, kind: 'page' as const, parentId: null, title: `Flat ${i}`, summary: 'flat', relatedPaths: ['src/main.ts'] }))
  await f.call('wiki_outline', { outline: { title: 'Flat', description: 'flat', pages } })
  assert.equal(f.job.outline?.pages.length, 10)
})
