import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePage } from '../src/host/quality.js'
import { mermaidGuidance } from '../src/host/prompts.js'
import type { SourceExcerpt } from '../src/shared/types.js'

const source = (path: string): SourceExcerpt => ({ id: path.replace(/\W/g, '').padEnd(32, '0').slice(0, 32), path, startLine: 1, endLine: 10, hash: 'hash', version: 'v1', text: 'export const value = 1' })
const sources = (...paths: string[]) => paths.map(source)
const page = (type: 'overview' | 'architecture' | 'module' | 'api' | 'data' | 'workflow' | 'config' | 'testing' | 'ops') => ({
  id: type, kind: 'page' as const, type, parentId: null, title: type, summary: type, relatedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
})
const diagram = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\`\n`
const content = (...blocks: string[]) => [
  '# 架构说明', '', '组件与流程说明。', '', '## 组件与职责', '', '`src/a.ts:L1`', '', '正文说明。'.repeat(220), '',
  '## 数据流', '', ...blocks,
].join('\n')

test('architecture pages accept useful text without a diagram quota', () => {
  const result = evaluatePage(page('architecture'), content(), sources('src/a.ts', 'src/b.ts', 'src/c.ts'), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  assert.deepEqual(result.hard, [])
  assert.doesNotMatch(result.soft.join('；'), /Mermaid 关系图不足（0\/2）/)
  const withDiagrams = evaluatePage(page('architecture'), content(diagram('flowchart LR\n  A --> B'), diagram('sequenceDiagram\n  A->>B: call')), sources('src/a.ts', 'src/b.ts', 'src/c.ts'), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  assert.equal(withDiagrams.mermaid, 2)
  assert.doesNotMatch(withDiagrams.soft.join('；'), /Mermaid 关系图不足/)
})

test('diagram counts do not scale with source count', () => {
  const moduleFive = evaluatePage(page('module'), content(), sources('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'])
  assert.doesNotMatch(moduleFive.soft.join('；'), /（0\/1）/)
  const moduleSix = evaluatePage(page('module'), content(), sources('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'])
  assert.doesNotMatch(moduleSix.soft.join('；'), /（0\/2）/)
  const data = evaluatePage(page('data'), content(), sources('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])
  assert.doesNotMatch(data.soft.join('；'), /（0\/2）/)
  const workflow = evaluatePage(page('workflow'), content(), sources('src/a.ts', 'src/b.ts'), ['src/a.ts', 'src/b.ts'])
  assert.doesNotMatch(workflow.soft.join('；'), /（0\/1）/)
})

test('invalid fenced diagrams do not count and prompt asks for supported diagram types', () => {
  const result = evaluatePage(page('api'), content(diagram('this is not a diagram')), sources('src/a.ts', 'src/b.ts', 'src/c.ts'), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  assert.equal(result.mermaid, 0)
  assert.match(result.soft.join('；'), /缺少有效图类型/)
  assert.match(mermaidGuidance, /sequenceDiagram/)
  assert.match(mermaidGuidance, /不要虚构/)
})

test('可读性上限：过长的段落、首段、小节与引用都会给出精简提示', () => {
  const longParagraph = '说明。'.repeat(400) // 单段 1,200 字符
  const content = [
    '# 架构说明', '', longParagraph, '',
    ...Array.from({ length: 14 }, (_, index) => `## 小节${index}`, '').flatMap(line => [line, '内容。', '']),
    '`src/a.ts:L1` '.repeat(45),
  ].join('\n')
  const result = evaluatePage(page('architecture'), content, sources('src/a.ts', 'src/b.ts'), ['src/a.ts', 'src/b.ts'])
  const soft = result.soft.join('；')
  assert.match(soft, /段落超过 400 字符/)
  assert.match(soft, /首段 \d+ 字符过长/)
  assert.match(soft, /二级标题 \d+ 个偏多/)
  assert.match(soft, /行内引用 \d+ 处偏多/)
  assert.deepEqual(result.hard, [], '上限只做软提示，不阻断提交')
})

test('可读性上限：单段超过 2,000 字符属于硬性失败', () => {
  const content = ['# 标题', '', '导语。', '', '## 小节', '', '说明。'.repeat(700), '', '## 另一节', '', '`src/a.ts:L1`'].join('\n')
  const result = evaluatePage(page('module'), content, sources('src/a.ts', 'src/b.ts'), ['src/a.ts', 'src/b.ts'])
  assert.match(result.hard.join('；'), /超过 2000 字符的段落/)
})

test('可读性上限：分段够长但未超限的页面不触发上限提示', () => {
  const body = '说明。'.repeat(100) // 单段 300 字符，低于 600 上限
  const content = ['# 标题', '', '三行结论。', '', '## 第一节', '', body, '', body, '', '`src/a.ts:L1`', '', '## 第二节', '', body].join('\n')
  const result = evaluatePage(page('module'), content, sources('src/a.ts', 'src/b.ts'), ['src/a.ts', 'src/b.ts'])
  const soft = result.soft.join('；')
  assert.doesNotMatch(soft, /段落超过|首段|二级标题|行内引用 \d+ 处偏多|超过 8000/)
  assert.deepEqual(result.hard, [])
})


test('可读性上限：正文超过 8,000 字符时提示精简', () => {
  const filler = '段落。'.repeat(100) // 单段 300 字符，不触发段落上限
  const content = ['# 标题', '', '导语。', '', ...Array.from({ length: 30 }, () => ['## 小节', '', filler, '']).flat(), '`src/a.ts:L1`'].join('\n')
  const result = evaluatePage(page('module'), content, sources('src/a.ts', 'src/b.ts'), ['src/a.ts', 'src/b.ts'])
  assert.ok(result.chars > 8000)
  assert.match(result.soft.join('；'), /正文 \d+ 字符超过 8000/)
})

test('可读性上限：用户页代码符号过密触发软警告，引用提示不再要求抄到页尾', () => {
  const jargon = '调用 `enhanceDraft` 后经 `validateRequest` 校验 `protectedTokens` 与 `settingsRevision`，再由 `BlockAssembler` 汇总 `AbortSignal` 并抛出 `EnhanceError`。'.repeat(3)
  const doc = ['# 使用指南', '', '快速上手。', '', '## 第一节', '', jargon, '', '## 第二节', '', jargon, '', '`src/a.ts:L1` '.repeat(15)].join('\n')
  const result = evaluatePage(page('workflow'), doc, sources('src/a.ts', 'src/b.ts'), ['src/a.ts', 'src/b.ts'], { userRoute: true })
  const soft = result.soft.join('；')
  assert.match(soft, /正文代码符号偏密/)
  assert.match(soft, /行内引用 \d+ 处偏多/)
  assert.doesNotMatch(soft, /收进页尾/)
})

test('分类导览页（isHub）允许精炼篇幅（400-3000 字符）且只需 1 个来源与 1 个二级标题', () => {
  const hub = { id: 'user-guide', kind: 'page' as const, isHub: true, type: 'guide' as const, parentId: null, title: '使用指南', summary: '使用指南总览', relatedPaths: ['README.md'] }
  const doc = ['# 使用指南', '', '本分类覆盖安装、日常操作、设置与排错。', '', '## 子页导航', '', '各功能操作请按需阅读对应子页。'.repeat(25), '', '`README.md:L1`'].join('\n')
  const result = evaluatePage(hub, doc, sources('README.md'), ['README.md'])
  assert.deepEqual(result.hard, [])
  assert.doesNotMatch(result.soft.join('；'), /超过 3000/)
  const bloated = ['# 使用指南', '', '导语。', '', '## 子页导航', '', '内容说明。'.repeat(900), '', '`README.md:L1`'].join('\n')
  const bloatedResult = evaluatePage(hub, bloated, sources('README.md'), ['README.md'])
  assert.match(bloatedResult.soft.join('；'), /超过 3000（导览页应精炼/)
})
