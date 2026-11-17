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
