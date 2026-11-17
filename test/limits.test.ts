import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { excludeMatcher, scanRepo, SCAN_LIMITS } from '../src/host/scanner.js'
import { validateSettings } from '../src/host/settings.js'
import { makeRepo, tempDir } from './helpers.js'

const baseSettings = { language: 'zh' as const, model: null, maxPages: 32, autoUpdate: false, autoExport: false }

test('文件枚举硬上限为 10,000，与 Qoder Repo Wiki 口径一致', () => {
  assert.equal(SCAN_LIMITS.maxEntries, 10_000)
  assert.equal(SCAN_LIMITS.maxExcludeRules, 200)
})

test('手工排除规则同时作用于目录与文件，且不进入文件树与摘录', async t => {
  const repo = await makeRepo(t)
  await mkdir(join(repo, 'packages/legacy'), { recursive: true })
  await writeFile(join(repo, 'packages/legacy/old.js'), 'export const legacy = 1\n')
  await writeFile(join(repo, 'src/legacy-helper.js'), 'export const helper = 2\n')

  const before = await scanRepo(repo)
  assert.ok(before.tree.includes('packages/legacy/old.js'))
  assert.ok(before.tree.includes('src/legacy-helper.js'))

  const after = await scanRepo(repo, { exclude: ['packages/legacy/', 'src/legacy-*'] })
  assert.ok(!after.tree.some(path => path.startsWith('packages/legacy')), '目录排除应整棵跳过')
  assert.ok(!after.tree.includes('src/legacy-helper.js'), '文件通配排除应生效')
  assert.ok(!after.excerpts.some(file => file.path === 'src/legacy-helper.js'), '摘录不应包含被排除文件')
  assert.ok(after.tree.includes('src/index.js'), '未命中规则的普通文件保留')
})

test('排除规则空值与注释被忽略，无规则时返回 null', () => {
  assert.equal(excludeMatcher(undefined), null)
  assert.equal(excludeMatcher([]), null)
  assert.equal(excludeMatcher(['', '   ', '# 注释']), null)
  const matcher = excludeMatcher(['build/', '# 注释'])
  assert.ok(matcher)
  assert.equal(matcher.test('build/').ignored, true)
  assert.equal(matcher.test('src/index.ts').ignored, false)
})

test('项目设置接受排除规则并做归一化，超限或类型错误被拒绝', () => {
  const accepted = validateSettings({ ...baseSettings, exclude: ['  dist/  ', '', 'vendor/**'] })
  assert.deepEqual(accepted.exclude, ['dist/', 'vendor/**'])
  assert.deepEqual(validateSettings({ ...baseSettings }).exclude, [])
  assert.throws(() => validateSettings({ ...baseSettings, exclude: [123] as never }), /排除规则必须是字符串/)
  assert.throws(() => validateSettings({ ...baseSettings, exclude: Array.from({ length: 201 }, () => 'a/') }), /最多 200 条/)
  assert.throws(() => validateSettings({ ...baseSettings, exclude: ['x'.repeat(201)] }), /不得超过 200 字符/)
})

test('未设置排除规则时行为与旧版一致（不丢弃任何未命中 .gitignore 的条目）', async t => {
  const repo = await makeRepo(t)
  const scan = await scanRepo(repo, { exclude: [] })
  assert.ok(scan.tree.includes('README.md'))
  assert.ok(scan.tree.includes('src/index.js'))
  assert.equal(scan.treeTruncated, false)
})

test('插件级排除规则与项目设置合并后参与可生成性判断', async t => {
  const { WikiPipeline } = await import('../src/host/pipeline.js')
  const repo = await makeRepo(t)
  const make = async (exclude: string[]) => new WikiPipeline({
    stateDir: join(await tempDir(t), 'state'), getLlm: () => ({}) as never, config: { exclude },
    getDefaultModel: () => ({ provider: 'fake', model: 'fake' }), agentRunner: async () => {}, autoPollMs: 0,
  })
  const excluded = await make(['README.md', 'package.json', 'src/'])
  assert.deepEqual(excluded.config.exclude, ['README.md', 'package.json', 'src/'])
  assert.equal((await excluded.configuration(repo)).canGenerate, false, '全部内容被插件级规则排除后不应可生成')
  const open = await make([])
  assert.equal((await open.configuration(repo)).canGenerate, true)
  await excluded.close(); await open.close()
})

test('插件级排除规则做归一化：去空、去非字符串、保留顺序', async t => {
  const { WikiPipeline } = await import('../src/host/pipeline.js')
  const pipeline = new WikiPipeline({
    stateDir: join(await tempDir(t), 'state'), getLlm: () => ({}) as never,
    config: { exclude: ['  dist/  ', 42, '', 'vendor/**'] as unknown as string[] },
    getDefaultModel: () => ({ provider: 'fake', model: 'fake' }), agentRunner: async () => {}, autoPollMs: 0,
  })
  assert.deepEqual(pipeline.config.exclude, ['dist/', 'vendor/**'])
  await pipeline.close()
})
