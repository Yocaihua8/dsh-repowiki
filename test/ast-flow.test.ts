import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeSource, augmentPages, dependencyMermaid, injectStructureBlock, structureDiagram, tokenize, FLOW_LIMITS } from '../src/host/ast-flow.js'

const sample = `// 说明注释
import { readFile } from './io.js'
import path from 'node:path'

export async function load(id: string): Promise<string> {
  if (!id) {
    throw new Error('missing')
  }
  const text = await readFile(id)
  if (text.length > 100) {
    return text.slice(0, 100)
  }
  return text
}

const parse = (input) => {
  for (const line of input) {
    if (line.startsWith('#')) continue
  }
  return input
}
`

test('tokenize 剥离注释、归一化字符串与模板字面量并保留行号', async () => {
  const tokens = tokenize(sample)
  assert.ok(tokens.length > 20)
  assert.ok(!tokens.some(token => token.value.includes('说明注释')), '行注释应被剥离')
  assert.ok(tokens.some(token => token.value === 'load' && token.line === 5), '函数名行号应准确')
  assert.equal(tokens.filter(token => token.kind === 'string').length >= 2, true)
})

test('analyzeSource 提取函数、控制结构与相对导入', async () => {
  const flow = analyzeSource('src/a.ts', sample)
  assert.deepEqual(flow.functions.map(fn => fn.name).sort(), ['load', 'parse'])
  const load = flow.functions.find(fn => fn.name === 'load')!
  assert.equal(load.async, true)
  assert.ok(load.steps.some(step => step.kind === 'if'), '应识别 if 分支')
  const firstIf = load.steps.find(step => step.kind === 'if')
  assert.ok(firstIf && firstIf.kind === 'if')
  assert.ok(firstIf.then.some(step => step.kind === 'throw'))
  assert.ok(load.steps.some(step => step.kind === 'call' && step.label.includes('readFile')))
  assert.ok(flow.imports.includes('./io.js'))
  assert.ok(!flow.imports.includes('node:path'), '只收相对导入')
})

test('structureDiagram 输出可被现有 Mermaid 规则识别的 flowchart', async () => {
  const diagram = await structureDiagram({ type: 'module', language: 'zh', files: [{ path: 'src/a.ts', text: sample }] })
  assert.ok(diagram)
  assert.equal(diagram.kind, 'control-flow')
  assert.ok(diagram.mermaid.startsWith('flowchart TD'))
  assert.ok(diagram.mermaid.includes('-->'), '应包含连线')
  assert.ok(diagram.mermaid.split('\n').length <= FLOW_LIMITS.maxNodes * 3 + 2, '节点数应受上限约束')
})

test('overview 页优先生成模块依赖图，且仅连接快照内文件', async () => {
  const other = `import { load } from './a.js'\nexport const boot = () => { load('x') }\n`
  const graph = dependencyMermaid([{ path: 'src/a.ts', text: sample }, { path: 'src/b.ts', text: other }], true)
  assert.ok(graph)
  assert.ok(graph.mermaid.startsWith('flowchart LR'))
  assert.ok(graph.mermaid.includes('-->'))
  assert.deepEqual(graph.files.sort(), ['src/a.ts', 'src/b.ts'])
  assert.ok(!graph.mermaid.includes('node:path'), '第三方模块不应进入图')
})

test('材料不足时返回空值而不报错', async () => {
  assert.equal(await structureDiagram({ type: 'module', language: 'zh', files: [] }), null)
  assert.equal(await structureDiagram({ type: 'module', language: 'zh', files: [{ path: 'src/empty.ts', text: 'export const x = 1' }] }), null)
  assert.equal(dependencyMermaid([{ path: 'src/a.ts', text: 'export const a = 1' }]), null)
})

test('injectStructureBlock 插在导语之后、正文之前，且重复调用幂等', async () => {
  const diagram = await structureDiagram({ type: 'module', language: 'zh', files: [{ path: 'src/a.ts', text: sample }] })!
  const page = '# 标题\n\n这是导语段落。\n\n## 第一节\n\n正文内容。\n'
  const once = injectStructureBlock(page, diagram, 'zh')
  const twice = injectStructureBlock(once, diagram, 'zh')
  assert.equal(once, twice)
  const titleIndex = once.indexOf('# 标题')
  const introIndex = once.indexOf('这是导语段落。')
  const blockIndex = once.indexOf('## 代码结构（Host 生成）')
  const sectionIndex = once.indexOf('## 第一节')
  assert.ok(titleIndex < introIndex && introIndex < blockIndex && blockIndex < sectionIndex)
  assert.ok(once.includes('```mermaid'))
  // 标题前必须是空行，避免被并入上一段或列表项
  assert.ok(once.includes('这是导语段落。\n\n## 代码结构（Host 生成）'))
})

test('无一级标题时结构图前置，不丢内容', async () => {
  const diagram = await structureDiagram({ type: 'module', language: 'zh', files: [{ path: 'src/a.ts', text: sample }] })!
  const injected = injectStructureBlock('没有标题的正文。', diagram, 'zh')
  assert.ok(injected.startsWith('## 代码结构（Host 生成）'))
  assert.ok(injected.includes('没有标题的正文。'))
})

test('augmentPages 只对有源码材料的页面注入，并保留原正文', async () => {
  const pages = [
    { id: 'module-a', content: '# 页面\n\n导语。\n\n## 第一节\n\n正文。', related: ['src/a.ts'] },
    { id: 'no-material', content: '# 空页\n\n导语。', related: [] },
  ]
  const injected = await augmentPages(pages, [{ path: 'src/a.ts', text: sample }], 'zh', id => id === 'module-a' ? 'module' : undefined)
  assert.equal(injected, 1)
  assert.ok(pages[0]!.content.includes('## 代码结构（Host 生成）'))
  assert.ok(pages[0]!.content.includes('正文。'))
  assert.ok(!pages[1]!.content.includes('代码结构（Host 生成）'))
})

test('augmentPages 对没有可解析结构的文件静默跳过', async () => {
  const pages = [{ id: 'p', content: '# 页\n\n导语。', related: ['src/config.json'] }]
  const injected = await augmentPages(pages, [{ path: 'src/config.json', text: '{"a":1}' }], 'zh')
  assert.equal(injected, 0)
  assert.equal(pages[0]!.content, '# 页\n\n导语。')
})
