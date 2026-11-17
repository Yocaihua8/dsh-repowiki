import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WikiPipeline } from '../src/host/pipeline.js'
import { readManifest, readPageContent, readSourceContent, writeWiki } from '../src/host/store.js'
import { exportWiki } from '../src/host/exporter.js'
import { captureSnapshot } from '../src/host/snapshot.js'
import { readExcerpts, scanRepo } from '../src/host/scanner.js'
import { validateOutline } from '../src/host/prompts.js'
import { markUnverifiedCitations } from '../src/host/citations.js'
import { fakeLlm, makeRepo, tempDir, textChunks } from './helpers.js'

const selection = { provider: 'test', model: 'selected', reasoningEffort: 'high' }
const one = JSON.stringify({ title: 'Repo', description: '', pages: [{ id: 'overview', title: 'Overview', summary: '', relatedPaths: ['README.md'] }] })
async function until(predicate: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
  assert.ok(predicate(), 'condition did not settle')
}
const git = (path: string, ...args: string[]) => promisify(execFile)('git', ['-C', path, ...args], { windowsHide: true }).then(r => r.stdout.trim())
async function gitRepo(t: Parameters<typeof tempDir>[0]) {
  const path = await tempDir(t)
  await git(path, 'init', '-b', 'main'); await git(path, 'config', 'user.name', 'RepoWiki test'); await git(path, 'config', 'user.email', 'repowiki-test@example.invalid')
  await mkdir(join(path, 'src'))
  await writeFile(join(path, 'README.md'), '# Test project\nTwo independent modules.\n')
  await writeFile(join(path, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(join(path, 'src', 'b.ts'), 'export const b = 1\n')
  await commit(path, 'initial')
  return path
}
async function commit(path: string, title: string) { await git(path, 'add', '.'); await git(path, 'commit', '-m', title); return git(path, 'rev-parse', 'HEAD') }
function dynamicLlm() {
  let paths = ['a', 'b']
  const llm = fakeLlm(Array.from({ length: 100 }, () => () => {
    const call = llm.calls.at(-1)!
    if (call.options?.system?.includes('资深软件架构师')) return textChunks(JSON.stringify({ title: 'Test', description: 'Test wiki', pages: [
      { id: 'overview', title: 'Overview', summary: 'Overview', relatedPaths: ['README.md'] },
      ...paths.map(p => ({ id: p, parentId: 'overview', title: p, summary: `${p} module`, relatedPaths: [`src/${p}.ts`] })),
    ] }))
    return textChunks(`# Page\n\nResponse ${llm.calls.length}\n\n|A|B|\n|---|---|\n|1|2|`)
  }))
  return { llm, setPaths: (next: string[]) => { paths = next } }
}

test('queue is global, duplicate submission shares ID, caller disconnect does not cancel, model is frozen', async t => {
  const repo = await makeRepo(t), other = await makeRepo(t, join(await tempDir(t), 'other'))
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const llm = fakeLlm([async () => { await gate; return textChunks(one) }, () => textChunks('# First'), () => textChunks(one), () => textChunks('# Second')])
  const pipeline = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir: await tempDir(t), getLlm: () => llm as never, getDefaultModel: () => ({ provider: 'default', model: 'old' }), autoPollMs: 0 })
  t.after(() => pipeline.dispose())
  const conf = await pipeline.configuration(repo)
  await pipeline.saveSettings(repo, { ...conf.settings, model: selection })
  const caller = new AbortController()
  const first = await pipeline.start({ repoPath: repo, signal: caller.signal })
  caller.abort()
  const second = await pipeline.start({ repoPath: other })
  assert.equal(pipeline.status(second.jobId).stage, 'queued')
  const duplicate = await pipeline.start({ repoPath: repo })
  assert.equal(duplicate.jobId, first.jobId); assert.equal(duplicate.started, false)
  await until(() => llm.calls.length === 1)
  await pipeline.saveSettings(repo, { ...conf.settings, model: { provider: 'changed', model: 'new' } })
  assert.equal(pipeline.status(first.jobId).running, true)
  release()
  await until(() => !pipeline.status(second.jobId).running)
  assert.equal(pipeline.status(first.jobId).stage, 'done')
  assert.equal(pipeline.status(second.jobId).stage, 'done')
  assert.deepEqual(llm.calls.slice(0, 2).map(c => c.selection), [selection, selection])
  assert.equal(pipeline.statuses().length, 2, 'reconnected clients can recover both jobs by ID')
})

test('unavailable model and empty source fail before queue admission', async t => {
  const llm = fakeLlm([])
  const pipeline = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir: await tempDir(t), getLlm: () => llm as never, autoPollMs: 0,
    getDefaultModel: () => selection, validateModel: async () => { throw new Error('unavailable route') } })
  const repo = await makeRepo(t)
  await assert.rejects(pipeline.start({ repoPath: repo }), /unavailable route/)
  await assert.rejects(pipeline.start({ repoPath: await tempDir(t) }), /没有可用于生成/)
  assert.equal(pipeline.statuses().length, 0); assert.equal(llm.calls.length, 0)
})

test('failure, cancellation and a failed version write retain readable previous wiki', async t => {
  const llm = fakeLlm([() => textChunks(one), () => textChunks('# Preserved'), () => textChunks('invalid'), async () => new Promise(() => {})])
  const pipeline = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir: await tempDir(t), getLlm: () => llm as never, getDefaultModel: () => selection, autoPollMs: 0 })
  t.after(() => pipeline.dispose())
  const repo = await makeRepo(t), first = await pipeline.start({ repoPath: repo })
  await until(() => !pipeline.status(first.jobId).running)
  const original = await pipeline.readManifest(first.wikiId)
  const failed = await pipeline.start({ repoPath: repo })
  await until(() => !pipeline.status(failed.jobId).running)
  assert.equal(pipeline.status(failed.jobId).stage, 'failed')
  const cancelled = await pipeline.start({ repoPath: repo })
  await until(() => llm.calls.length === 4)
  pipeline.cancel(cancelled.jobId)
  await until(() => !pipeline.status(cancelled.jobId).running)
  assert.equal(pipeline.status(cancelled.jobId).stage, 'cancelled')
  await assert.rejects(writeWiki(pipeline.stateDir, original, [{ id: '../unsafe', title: '', summary: '', related: [], content: 'broken' }]))
  assert.equal((await pipeline.readManifest(first.wikiId)).revision, original.revision)
  assert.equal((await pipeline.readPage(first.wikiId, 'overview')).content, '# Preserved')
})

test('Git increments regenerate affected pages, preserve others, use committed blobs and skip export-only commits', async t => {
  const repo = await gitRepo(t), stateDir = await tempDir(t), { llm } = dynamicLlm()
  const pipeline = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir, getLlm: () => llm as never, getDefaultModel: () => selection, autoPollMs: 0 })
  t.after(() => pipeline.dispose())
  const config = await pipeline.configuration(repo)
  await pipeline.saveSettings(repo, { ...config.settings, autoUpdate: true, autoExport: true })
  const first = await pipeline.start({ repoPath: repo })
  await until(() => !pipeline.status(first.jobId).running)
  assert.equal(pipeline.status(first.jobId).stage, 'done')
  const old = await pipeline.readManifest(first.wikiId), beforeB = await pipeline.readPage(first.wikiId, 'b')
  assert.equal(llm.calls.length, 4)
  await pipeline.pollAutoUpdates(); assert.equal(pipeline.statuses().length, 1)
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2\n')
  const head = await commit(repo, 'change a')
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 999 // uncommitted\n')
  await pipeline.pollAutoUpdates()
  await until(() => !pipeline.status().running)
  assert.equal(pipeline.status().stage, 'done')
  assert.equal(llm.calls.length, 6, 'only overview and a are regenerated')
  const updated = await pipeline.readManifest(first.wikiId)
  assert.equal(updated.source?.commit, head)
  assert.notEqual(updated.revision, old.revision)
  assert.equal((await pipeline.readPage(first.wikiId, 'b')).content, beforeB.content)
  const ref = updated.pages.find(p => p.id === 'a')!.sources!.find(s => s.path === 'src/a.ts')!
  const source = await readSourceContent(stateDir, updated, ref.id)
  assert.equal(source.text, 'export const a = 2\n'); assert.equal(source.version, head)
  assert.ok(source.endLine >= source.startLine)
  assert.match(await readFile(join(repo, '.dsh/repowiki/zh/page-a.md'), 'utf8'), /Page/)
  await git(repo, 'checkout', '--', 'src/a.ts')
  await commit(repo, 'export files only')
  await pipeline.pollAutoUpdates(); await until(() => !pipeline.status().running)
  assert.equal(llm.calls.length, 6, 'exported files never enter the source index')
})

test('Git additions, deletion and rename replan, branch switch pauses until full regeneration', async t => {
  const repo = await gitRepo(t), { llm, setPaths } = dynamicLlm()
  const pipeline = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir: await tempDir(t), getLlm: () => llm as never, getDefaultModel: () => selection, autoPollMs: 0 })
  t.after(() => pipeline.dispose())
  await pipeline.saveSettings(repo, { ...(await pipeline.configuration(repo)).settings, autoUpdate: true })
  const first = await pipeline.start({ repoPath: repo }); await until(() => !pipeline.status().running)
  await writeFile(join(repo, 'src/c.ts'), 'export const c = 1\n'); setPaths(['a', 'b', 'c']); await commit(repo, 'add c')
  await pipeline.pollAutoUpdates(); await until(() => !pipeline.status().running)
  assert.equal((await pipeline.readManifest(first.wikiId)).pages.length, 4)
  await unlink(join(repo, 'src/a.ts')); await rename(join(repo, 'src/b.ts'), join(repo, 'src/d.ts')); setPaths(['c', 'd']); await commit(repo, 'delete a rename b')
  await pipeline.pollAutoUpdates(); await until(() => !pipeline.status().running)
  assert.deepEqual((await pipeline.readManifest(first.wikiId)).pages.map(p => p.id), ['overview', 'c', 'd'])
  const calls = llm.calls.length
  await git(repo, 'checkout', '-b', 'other')
  await pipeline.pollAutoUpdates()
  assert.match((await pipeline.configuration(repo)).updateNotice ?? '', /分支已切换/)
  assert.equal(llm.calls.length, calls)
  const fresh = await pipeline.start({ repoPath: repo }); await until(() => !pipeline.status(fresh.jobId).running)
  assert.equal((await pipeline.configuration(repo)).updateNotice, null)
  assert.equal((await pipeline.readManifest(first.wikiId)).source?.branch, 'other')
})

test('failed automatic commit does not retry on every poll; explicit retry can recover', async t => {
  const repo = await gitRepo(t)
  const llm = fakeLlm([() => textChunks(one), () => textChunks('# Original'), () => textChunks('', 'error'), () => textChunks('# Retry')])
  const pipeline = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir: await tempDir(t), getLlm: () => llm as never, getDefaultModel: () => selection, autoPollMs: 0 })
  t.after(() => pipeline.dispose())
  await pipeline.saveSettings(repo, { ...(await pipeline.configuration(repo)).settings, autoUpdate: true })
  await pipeline.start({ repoPath: repo }); await until(() => !pipeline.status().running)
  await writeFile(join(repo, 'README.md'), '# Changed\n'); await commit(repo, 'readme')
  await pipeline.pollAutoUpdates(); await until(() => !pipeline.status().running)
  assert.equal(pipeline.status().stage, 'partial')
  await pipeline.pollAutoUpdates(); await pipeline.pollAutoUpdates(); assert.equal(llm.calls.length, 3)
  const retry = await pipeline.start({ repoPath: repo, mode: 'update' }); await until(() => !pipeline.status(retry.jobId).running)
  assert.equal(pipeline.status(retry.jobId).stage, 'done')
})

test('export refuses manual edits before writing any page, preserving unknown files', async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  const manifest = { id: 'test-wiki', repoPath: repo, title: 'Wiki', description: '', language: 'zh', createdAt: '', updatedAt: '', generator: 'dsh-repowiki' }
  let saved = await writeWiki(state, manifest, [{ id: 'overview', title: 'Overview', summary: '', related: [], content: '# Old' }])
  const result = await exportWiki(state, saved)
  await writeFile(join(result.directory, 'page-overview.md'), '# My edit')
  await writeFile(join(result.directory, 'notes.txt'), 'mine')
  const before = await readFile(join(result.directory, 'README.md'), 'utf8')
  saved = await writeWiki(state, manifest, [{ id: 'overview', title: 'Changed title', summary: '', related: [], content: '# New' }])
  await assert.rejects(exportWiki(state, saved), /人工修改/)
  assert.equal(await readFile(join(result.directory, 'page-overview.md'), 'utf8'), '# My edit')
  assert.equal(await readFile(join(result.directory, 'README.md'), 'utf8'), before)
  assert.equal(await readFile(join(result.directory, 'notes.txt'), 'utf8'), 'mine')
})

test('export metadata is protected by a private receipt and readme page IDs cannot overwrite the index', async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  const saved = await writeWiki(state, { id: 'export-wiki', repoPath: repo, title: 'Index', description: '', language: 'zh', createdAt: '', updatedAt: '', generator: 'dsh-repowiki' },
    [{ id: 'readme', title: 'Readme page', summary: '', related: [], content: '# Page body' }])
  const result = await exportWiki(state, saved)
  assert.match(await readFile(join(result.directory, 'README.md'), 'utf8'), /^# Index/)
  assert.equal(await readFile(join(result.directory, 'page-readme.md'), 'utf8'), '# Page body')
  await exportWiki(state, saved)
  await writeFile(join(result.directory, '.repowiki-export.json'), (await readFile(join(result.directory, '.repowiki-export.json'), 'utf8')) + '\n')
  await assert.rejects(exportWiki(state, saved), /元信息已修改/)
})

test('scanner enforces real byte budget, nested ignores, UTF-8 and excludes export directory', async t => {
  const repo = await makeRepo(t)
  await writeFile(join(repo, '.gitignore'), 'src/*.js\n!src/index.js\n')
  await writeFile(join(repo, 'src/.gitignore'), 'ignored.ts\n')
  await writeFile(join(repo, 'src/ignored.ts'), 'must not be read')
  await writeFile(join(repo, 'src/huge.ts'), '汉字'.repeat(10000))
  await mkdir(join(repo, '.dsh/repowiki/zh'), { recursive: true })
  await writeFile(join(repo, '.dsh/repowiki/zh/overview.md'), 'export')
  const scan = await scanRepo(repo, { totalBudgetBytes: 500, maxFileBytes: 200 })
  assert.ok(scan.tree.includes('src/index.js'))
  assert.ok(!scan.tree.includes('src/util.js')); assert.ok(!scan.tree.includes('src/ignored.ts'))
  assert.ok(!scan.tree.some(p => p.startsWith('.dsh')))
  const material = [...scan.docs, ...await readExcerpts(scan)]
  assert.ok(material.reduce((n, f) => n + Buffer.byteLength(f.text), 0) <= 500)
  assert.ok(material.every(f => !f.text.includes('�')))
  assert.ok(scan.sourceFiles.find(f => f.path === 'src/huge.ts')!.bytes === 60000)
})

test('outline refuses cycles, missing parents and depth four; one-page projects are valid', () => {
  const validate = (pages: unknown[]) => validateOutline({ title: 'Wiki', pages }, { maxPages: 24 })
  assert.throws(() => validate([{ id: 'a', title: 'a', parentId: 'b' }, { id: 'b', title: 'b', parentId: 'a' }]), /循环/)
  assert.throws(() => validate([{ id: 'a', title: 'a', parentId: 'missing' }]), /父级/)
  assert.throws(() => validate(['a', 'b', 'c', 'd'].map((id, i, list) => ({ id, title: id, parentId: i ? list[i - 1] : null }))), /三级/)
  assert.equal(validate([{ id: 'overview', title: 'Overview' }]).pages.length, 1)
})

test('legacy manifest reads remain compatible and snapshot source is bounded', async t => {
  const state = await tempDir(t), root = join(state, 'wikis/legacy')
  await mkdir(join(root, 'pages'), { recursive: true })
  await writeFile(join(root, 'pages/overview.md'), '# Legacy')
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ id: 'legacy', pages: [{ id: 'overview', file: 'pages/overview.md' }] }))
  assert.equal((await readManifest(state, 'legacy'))?.revision, undefined)
  assert.equal(await readPageContent(state, 'legacy', 'overview'), '# Legacy')
  const snapshot = await captureSnapshot(await makeRepo(t), undefined, new AbortController().signal)
  assert.ok(snapshot.files.every(f => f.hash.length === 64 && Buffer.byteLength(f.text) <= 65536))
})

test('queued automatic commits coalesce to latest commit, queued cancellation does not stop the active project', async t => {
  const repo = await gitRepo(t), blocker = await makeRepo(t), { llm } = dynamicLlm()
  let block = false, release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const original = llm.prepareCall.bind(llm)
  llm.prepareCall = async (model, signal) => {
    if (block) { block = false; await gate }
    return original(model, signal)
  }
  const pipeline = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir: await tempDir(t), getLlm: () => llm as never, getDefaultModel: () => selection, autoPollMs: 0 })
  t.after(() => { release(); pipeline.dispose() })
  await pipeline.saveSettings(repo, { ...(await pipeline.configuration(repo)).settings, autoUpdate: true })
  const first = await pipeline.start({ repoPath: repo }); await until(() => !pipeline.status().running)
  block = true
  const held = await pipeline.start({ repoPath: blocker })
  await until(() => pipeline.status(held.jobId).stage === 'plan')
  await writeFile(join(repo, 'src/a.ts'), 'export const a = 2\n'); await commit(repo, 'two')
  await pipeline.pollAutoUpdates()
  const queued = pipeline.statuses().find(s => s.trigger === 'auto')!
  assert.equal(queued.stage, 'queued')
  await writeFile(join(repo, 'src/a.ts'), 'export const a = 3\n'); const head = await commit(repo, 'three')
  await pipeline.pollAutoUpdates()
  assert.equal(pipeline.statuses().filter(s => s.trigger === 'auto').length, 1)
  const cancelled = await pipeline.start({ repoPath: await makeRepo(t) })
  pipeline.cancel(cancelled.jobId); assert.equal(pipeline.status(cancelled.jobId).stage, 'cancelled')
  assert.equal(pipeline.status(held.jobId).running, true)
  release(); await until(() => !pipeline.status(queued.jobId).running)
  assert.equal((await pipeline.readManifest(first.wikiId)).source?.commit, head)
})

test('automatic export conflict is a warning on a successful new wiki', async t => {
  const repo = await makeRepo(t), llm = fakeLlm([() => textChunks(one), () => textChunks('# First'), () => textChunks(one), () => textChunks('# Second')])
  const pipeline = new WikiPipeline({ newEngine: 'legacy', qualityPolicy: 'legacy', stateDir: await tempDir(t), getLlm: () => llm as never, getDefaultModel: () => selection, autoPollMs: 0 })
  await pipeline.saveSettings(repo, { ...(await pipeline.configuration(repo)).settings, autoExport: true })
  const first = await pipeline.start({ repoPath: repo }); await until(() => !pipeline.status().running)
  await writeFile(join(repo, '.dsh/repowiki/zh/page-overview.md'), 'manual edit')
  const second = await pipeline.start({ repoPath: repo }); await until(() => !pipeline.status(second.jobId).running)
  assert.equal(pipeline.status(second.jobId).stage, 'done'); assert.match(pipeline.status(second.jobId).warning!, /导出失败/)
  assert.equal((await pipeline.readPage(first.wikiId, 'overview')).content, '# Second')
  assert.equal(await readFile(join(repo, '.dsh/repowiki/zh/page-overview.md'), 'utf8'), 'manual edit')
})

test('committed snapshots respect ignore rules and unsupported line citations are marked', async t => {
  const repo = await gitRepo(t)
  await writeFile(join(repo, '.gitignore'), 'src/a.ts\n')
  const head = await commit(repo, 'ignore previously tracked a')
  const snapshot = await captureSnapshot(repo, head, new AbortController().signal)
  assert.ok(!snapshot.files.some(f => f.path === 'src/a.ts'))
  const source = snapshot.files.find(f => f.path === 'src/b.ts')!
  assert.equal(markUnverifiedCitations('`src/b.ts:L1-L1`', [source], 'zh'), '`src/b.ts:L1-L1`')
  assert.match(markUnverifiedCitations('`src/b.ts:L99`', [source], 'zh'), /未核实/)
  assert.match(markUnverifiedCitations('`missing.ts:L1`', [source], 'en'), /unverified/)
})
