import assert from 'node:assert/strict'
import test from 'node:test'
import { extractJsonObject, resolveSelection } from '../src/host/llm.js'
import { coverageMatrix, pagePrompts, planPrompts, formatCoverageMatrix, validateOutline } from '../src/host/prompts.js'
import { listWikis, readManifest, readPageContent, wikiIdFor, writeWiki } from '../src/host/store.js'
import { tempDir } from './helpers.js'

test('resolveSelection 提取会话当前模型，缺失时抛 repowiki/no-model', () => {
  const agent = { id: 'session-1', session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } }) } }
  assert.deepEqual(resolveSelection(agent), { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
  assert.deepEqual(
    resolveSelection({ id: 's', session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }),
    { provider: 'p', model: 'm' },
  )
  assert.throws(() => resolveSelection(undefined), error => (error as { code: string }).code === 'repowiki/no-model')
  assert.throws(
    () => resolveSelection({ session: { requestHeader: () => ({ config: { provider: 'p' } }) } }),
    error => (error as { code: string }).code === 'repowiki/no-model',
  )
})

test('extractJsonObject 容错解析围栏与前后杂讯', () => {
  const plan = { title: 'T', pages: [{ id: 'overview' }] }
  assert.deepEqual(extractJsonObject(JSON.stringify(plan)), plan)
  assert.deepEqual(extractJsonObject('```json\n' + JSON.stringify(plan, null, 2) + '\n```'), plan)
  assert.deepEqual(extractJsonObject('前置说明\n' + JSON.stringify(plan) + '\n后缀'), plan)
  assert.deepEqual(extractJsonObject('{"a": "含 } 花括号与 \\" 转义"}'), { a: '含 } 花括号与 " 转义' })
  assert.equal(extractJsonObject('没有 JSON'), null)
  assert.equal(extractJsonObject(''), null)
})

test('validateOutline 校验 id、数量与字段边界', () => {
  const outline = validateOutline({
    title: '维基',
    description: '描述',
    pages: [
      { id: 'overview', title: '总览', summary: 'a', relatedPaths: ['README.md', 42] },
      { id: 'arch', title: '架构', summary: '', relatedPaths: [] },
    ],
  }, { maxPages: 8 })
  assert.equal(outline.pages.length, 2)
  assert.deepEqual(outline.pages[0]?.relatedPaths, ['README.md'])

  assert.throws(() => validateOutline(null, { maxPages: 8 }), error => (error as { code: string }).code === 'repowiki/invalid-outline')
  assert.throws(() => validateOutline({ title: '', pages: [{ id: 'a', title: 'x' }] }, { maxPages: 8 }), error => (error as { code: string }).code === 'repowiki/invalid-outline')
  assert.throws(() => validateOutline({ title: 't', pages: [] }, { maxPages: 8 }), error => (error as { code: string }).code === 'repowiki/invalid-outline')
  assert.throws(() => validateOutline({ title: 't', pages: [{ id: 'Bad Id', title: 'x' }] }, { maxPages: 8 }), error => (error as { code: string }).code === 'repowiki/invalid-outline')
  assert.throws(() => validateOutline({ title: 't', pages: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] }, { maxPages: 8 }), error => (error as { code: string }).code === 'repowiki/invalid-outline')
  assert.throws(() => validateOutline({ title: 't', pages: [{ id: 'a' }] }, { maxPages: 8 }), error => (error as { code: string }).code === 'repowiki/invalid-outline')
  const many = { title: 't', pages: Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, title: `页${i}` })) }
  assert.throws(() => validateOutline(many, { maxPages: 8 }), error => (error as { code: string }).code === 'repowiki/invalid-outline')
})

test('wikiIdFor 对同一路径稳定，并产出合法 id', () => {
  const first = wikiIdFor('E:\\Dev\\Demo-Repo')
  assert.match(first, /^demo-repo-[0-9a-f]{8}$/)
  assert.notEqual(wikiIdFor('E:\\Dev\\other'), first)
  if (process.platform === 'win32') {
    assert.equal(wikiIdFor('E:\\Dev\\demo-repo'), first)
  }
})

test('store 写入/读取/列出维基，覆盖与 id 白名单', async (t) => {
  const stateDir = await tempDir(t)
  const manifest = {
    id: wikiIdFor('E:\\Dev\\sample-repo'),
    title: '示例维基',
    description: '描述',
    repoPath: 'E:\\Dev\\sample-repo',
    language: 'zh',
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    generator: 'dsh-repowiki',
  }
  await writeWiki(stateDir, manifest, [
    { id: 'overview', title: '总览', summary: 'a', content: '# 总览\n', related: ['README.md'] },
    { id: 'arch', title: '架构', summary: 'b', content: '# 架构\n', related: [] },
  ])
  const saved = await readManifest(stateDir, manifest.id)
  assert.equal(saved?.title, '示例维基')
  assert.equal(saved?.pages.length, 2)
  assert.deepEqual(saved?.pages[0]?.related, ['README.md'])
  assert.equal(await readPageContent(stateDir, manifest.id, 'overview'), '# 总览\n')
  await assert.rejects(
    readPageContent(stateDir, manifest.id, '../escape'),
    error => (error as { code: string }).code === 'repowiki/invalid-id',
  )
  const listed = await listWikis(stateDir)
  assert.equal(listed.length, 1)
  // 覆盖：页面重建
  await writeWiki(stateDir, manifest, [{ id: 'overview', title: '总览 v2', summary: 'a', content: '# v2\n', related: [] }])
  const updated = await readManifest(stateDir, manifest.id)
  assert.equal(updated?.pages.length, 1)
  assert.equal(await readPageContent(stateDir, manifest.id, 'arch'), null)
})

test('coverage matrix and prompts expose module/category coverage without padding language', () => {
  const paths = ['README.md', 'package.json', 'src/host/a.ts', 'src/host/b.ts', 'src/host/c.ts', 'src/client/a.ts', 'test/a.test.ts', 'docs/guide.md', 'scripts/build.mjs']
  const matrix = coverageMatrix(paths)
  assert.ok(matrix.some(item => item.category === 'overview'))
  assert.ok(matrix.some(item => item.category === 'quickstart'))
  assert.ok(matrix.some(item => item.category === 'module:src/host' && item.files === 3))
  assert.ok(matrix.some(item => item.category === 'testing'))
  assert.ok(matrix.some(item => item.category === 'ops'))
  const scan = { root: '/repo', tree: paths, treeTruncated: false, docs: [{ path: 'README.md', text: 'readme', truncated: false }], excerpts: [{ path: 'src/host/a.ts', text: 'code', truncated: false }] }
  const plan = planPrompts({ scan, language: 'zh', maxPages: 32 })
  assert.match(plan.system, /覆盖矩阵/)
  assert.doesNotMatch(plan.system, /小项目不要凑页数/)
  const page = { id: 'host', type: 'module' as const, title: 'Host 模块', summary: '宿主模块', sections: ['职责', '接口'], coverage: ['module:src/host'], relatedPaths: ['src/host/a.ts'] }
  const prompts = pagePrompts({ scan, outline: { title: 'T', description: 'D', pages: [page] }, page, language: 'zh' })
  assert.match(prompts.system, /本页类型 module/)
  assert.match(prompts.system, /职责/)
  const outline = validateOutline({ title: 'T', pages: [{ ...page, kind: 'page' }] }, { maxPages: 32 })
  assert.equal(outline.pages[0]!.type, 'module')
  assert.deepEqual(outline.pages[0]!.sections, ['职责', '接口'])
  assert.deepEqual(outline.pages[0]!.coverage, ['module:src/host'])
})

test('coverage matrix supplies evidence hints without page quotas', () => {
 const paths = Array.from({length:90},(_,i)=>`src/host/file${i}.ts`)
 const matrix = coverageMatrix(paths)
 assert.equal(matrix.find(i=>i.category==='module:src/host')?.files,90)
 assert.doesNotMatch(formatCoverageMatrix(matrix,90), /目标.*页|至少.*页/)
})

test('store round trips shared reading routes and page boundaries without copying bodies', async t => {
 const dir=await tempDir(t)
 const manifest={id:'routes',title:'Wiki',description:'Shared',repoPath:'/repo',language:'zh',createdAt:'now',updatedAt:'now',generator:'dsh-repowiki',readingPaths:{user:['intro'],developer:['intro','deep'],maintainer:['deep']}}
 await writeWiki(dir,manifest,[{id:'intro',title:'Intro',summary:'Use',content:'# Intro',related:[],readerQuestion:'How?',scope:'Basics',relatedPageIds:['deep']},{id:'deep',title:'Details',summary:'Maintain',content:'# Details',related:[]}])
 const saved=await readManifest(dir,'routes')
 assert.deepEqual(saved?.readingPaths,manifest.readingPaths)
 assert.equal(saved?.pages.length,2)
 assert.equal(saved?.pages[0]?.readerQuestion,'How?')
 assert.deepEqual(saved?.pages[0]?.relatedPageIds,['deep'])
 await writeWiki(dir,manifest,[{id:'intro',title:'Intro',summary:'Use',content:'# Updated',related:[]}])
 const updated = await readManifest(dir,manifest.id)
 assert.deepEqual(updated?.readingPaths,{user:['intro'],developer:['intro'],maintainer:[]})
 assert.equal(await readPageContent(dir,manifest.id,'deep'),null)
})
