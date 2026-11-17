import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CHECKPOINT_LIMITS, CheckpointStore, type Checkpoint } from '../src/host/checkpoints.js'
import type { SourceExcerpt } from '../src/shared/types.js'
import { tempDir } from './helpers.js'

const source: SourceExcerpt = { id: 's1', path: 'README.md', startLine: 1, endLine: 1, hash: 'h', version: 'v', text: 'hello' }
function checkpoint(id = '11111111-1111-4111-8111-111111111111'): Checkpoint {
  return {
    schemaVersion: 2, mode: 'generate', selection: { provider: 'p', model: 'm' },
    settings: { language: 'zh', model: null, maxPages: 32, autoUpdate: false, autoExport: false },
    pages: [{ id: 'overview', title: 'T', summary: 'S', parentId: null, content: '# T', sources: [source], related: ['README.md'] }],
    cards: [], verified: [],
    status: { running: false, stage: 'idle', wikiId: 'wiki', repoPath: 'repo', jobId: id, pagesDone: 0, pagesTotal: 0, error: null, result: null },
    agentState: { sessionId: 'session', sessionCreated: true, progress: 1, stalledRounds: 0, evidence: [source], revisions: [],
      receipts: { call: { digest: 'digest', result: { ok: true } } }, verifications: {} },
  }
}

test('checkpoint evidence and receipts are sharded and hydrated transparently', async t => {
  const directory = await tempDir(t), store = new CheckpointStore(directory), data = checkpoint()
  await store.save(data)
  const raw = JSON.parse(await readFile(join(directory, 'jobs', data.status.jobId!, 'checkpoint.json'), 'utf8')) as Checkpoint
  assert.deepEqual(raw.agentState!.evidence, [])
  assert.deepEqual(raw.agentState!.receipts, {})
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'jobs', data.status.jobId!, 'evidence.json'), 'utf8')), [source])
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'jobs', data.status.jobId!, 'receipts.json'), 'utf8')), data.agentState!.receipts)
  const loaded = (await store.list())[0]!
  assert.deepEqual(loaded.agentState!.evidence, [source])
  assert.deepEqual(loaded.agentState!.receipts, data.agentState!.receipts)
})

test('legacy checkpoints with inline evidence and receipts still load', async t => {
  const directory = await tempDir(t), data = checkpoint('22222222-2222-4222-8222-222222222222')
  await mkdir(join(directory, 'jobs', data.status.jobId!), { recursive: true })
  await writeFile(join(directory, 'jobs', data.status.jobId!, 'checkpoint.json'), JSON.stringify(data))
  const loaded = (await new CheckpointStore(directory).list())[0]!
  assert.deepEqual(loaded.agentState!.evidence, [source])
  assert.deepEqual(loaded.agentState!.receipts, data.agentState!.receipts)
})

test('checkpoint structure size is bounded before writing', async t => {
  const directory = await tempDir(t), data = checkpoint('33333333-3333-4333-8333-333333333333')
  data.pages[0]!.content = 'x'.repeat(CHECKPOINT_LIMITS.checkpointBytes + 1)
  await assert.rejects(new CheckpointStore(directory).save(data), /checkpoint 结构超过安全上界/)
})

test('receipt shard keeps the newest bounded entries', async t => {
  const directory = await tempDir(t), data = checkpoint('44444444-4444-4444-8444-444444444444')
  data.agentState!.receipts = Object.fromEntries(Array.from({ length: CHECKPOINT_LIMITS.receiptsEntries + 5 }, (_, i) => [`call-${i}`, { digest: String(i), result: i }]))
  await new CheckpointStore(directory).save(data)
  const loaded = (await new CheckpointStore(directory).list())[0]!
  assert.equal(Object.keys(loaded.agentState!.receipts).length, CHECKPOINT_LIMITS.receiptsEntries)
  assert.equal(loaded.agentState!.receipts['call-0'], undefined)
  assert.equal(loaded.agentState!.receipts[`call-${CHECKPOINT_LIMITS.receiptsEntries + 4}`]?.digest, String(CHECKPOINT_LIMITS.receiptsEntries + 4))
})

test('源码快照以 gzip 落盘，并兼容旧的未压缩快照', async t => {
  const directory = await tempDir(t), store = new CheckpointStore(directory)
  const id = '55555555-5555-4555-8555-555555555555'
  const snapshot = {
    root: '/repo', tree: ['README.md'], truncated: false,
    source: { kind: 'working' as const, commit: null, branch: null, fingerprint: 'fp' },
    files: [{ id: 'a', path: 'README.md', startLine: 1, endLine: 1, hash: 'h', version: 'v1', text: 'hello' }],
  }
  await store.saveSnapshot(id, snapshot)
  const jobDir = join(directory, 'jobs', id)
  const compressed = await readFile(join(jobDir, 'snapshot.json.gz'))
  assert.equal(compressed[0], 0x1f, '应以 gzip magic 开头')
  assert.equal(compressed[1], 0x8b)
  await assert.rejects(readFile(join(jobDir, 'snapshot.json'), 'utf8'), '不应再写未压缩快照')
  assert.deepEqual(await store.snapshot(id), snapshot)

  // 旧任务的未压缩快照仍可读取
  const legacyId = '66666666-6666-4666-8666-666666666666'
  await mkdir(join(directory, 'jobs', legacyId), { recursive: true })
  await writeFile(join(directory, 'jobs', legacyId, 'snapshot.json'), JSON.stringify(snapshot))
  assert.deepEqual(await new CheckpointStore(directory).snapshot(legacyId), snapshot)
  assert.equal(await store.snapshot('77777777-7777-4777-8777-777777777777'), undefined)
})
