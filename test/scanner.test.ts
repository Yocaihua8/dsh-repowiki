import assert from 'node:assert/strict'
import test from 'node:test'
import { readExcerpts, scanRepo } from '../src/host/scanner.js'
import { makeRepo, tempDir } from './helpers.js'

test('scanRepo 收集文件树、文档与源码候选，跳过依赖与构建目录', async (t) => {
  const repo = await makeRepo(t)
  const scan = await scanRepo(repo)

  assert.ok(scan.tree.includes('README.md'))
  assert.ok(scan.tree.includes('package.json'))
  assert.ok(scan.tree.includes('src/'))
  assert.ok(scan.tree.includes('src/index.js'))
  assert.ok(!scan.tree.some(path => path.startsWith('node_modules')), 'node_modules 应被跳过')
  assert.ok(!scan.tree.some(path => path.startsWith('.git')), '.git 应被跳过')
  assert.ok(!scan.tree.some(path => path.startsWith('dist')), 'dist 应被跳过')

  const docPaths = scan.docs.map(doc => doc.path)
  assert.deepEqual(docPaths.sort(), ['README.md', 'package.json'])
  assert.match(scan.docs.find(doc => doc.path === 'README.md')?.text ?? '', /示例仓库/)

  assert.ok(scan.excerpts.some(file => file.path === 'src/index.js'))
  assert.ok(scan.excerpts.every(file => !file.path.startsWith('node_modules')))
})

test('scanRepo 拒绝不存在的路径与非目录路径', async (t) => {
  const base = await tempDir(t)
  await assert.rejects(
    scanRepo(`${base}${Date.now()}-missing`),
    error => error instanceof Error && 'code' in error && (error as { code: string }).code === 'repowiki/path-not-found',
  )
})

test('scanRepo 条目上限生效并标记截断', async (t) => {
  const repo = await makeRepo(t)
  const scan = await scanRepo(repo, { maxEntries: 3 })
  assert.ok(scan.tree.length <= 3)
  assert.equal(scan.treeTruncated, true)
})

test('scanRepo 深度上限标记未读取子目录，不把边界当作完整扫描', async t => {
  const scan = await scanRepo(await makeRepo(t), { maxDepth: 1 })
  assert.equal(scan.treeTruncated, true)
  assert.ok(scan.tree.includes('src/')); assert.ok(!scan.tree.includes('src/index.js'))
})

test('readExcerpts 读取实际文本并按上限截断', async (t) => {
  const repo = await makeRepo(t)
  const scan = await scanRepo(repo, { maxExcerptFiles: 4 })
  const excerpts = await readExcerpts(scan, scan.excerpts.map(file => ({ ...file, capBytes: 8 })))
  assert.ok(excerpts.length > 0)
  for (const file of excerpts) {
    assert.ok(Buffer.byteLength(file.text, 'utf8') <= 8)
    assert.equal(file.truncated, true)
  }
})

test('scanRepo and readExcerpts honor an aborted caller signal', async (t) => {
  const repo = await makeRepo(t)
  const controller = new AbortController()
  controller.abort(new Error('caller-cancelled'))
  await assert.rejects(scanRepo(repo, {}, controller.signal), /caller-cancelled/)
  const scan = await scanRepo(repo)
  await assert.rejects(readExcerpts(scan, scan.excerpts, controller.signal), /caller-cancelled/)
})
