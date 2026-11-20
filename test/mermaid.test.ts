import assert from 'node:assert/strict'
import test from 'node:test'
import { findMermaidFences, hasMermaidDiagramType, mermaidFenceStats, splitMermaidDiagrams } from '../src/shared/mermaid.js'
import { buildMermaidTheme, themeSignature, type MermaidPalette } from '../src/client/mermaid-theme.js'
import { evaluatePage } from '../src/host/quality.js'
import type { SourceExcerpt } from '../src/shared/types.js'

const fence = (code: string, info = '') => `\`\`\`mermaid${info}\n${code}\n\`\`\``
const valid = ['flowchart TD\n  A --> B', 'graph LR\n  A --> B', 'sequenceDiagram\n  A->>B: call', 'stateDiagram-v2\n  [*] --> S', 'classDiagram\n  A <|-- B', 'erDiagram\n  A ||--o{ B : has']

test('支持的 Mermaid 图类型被识别，未知类型与空块不进入渲染', () => {
  for (const code of valid) assert.equal(hasMermaidDiagramType(code), true, code)
  for (const code of ['', '   ', 'not a diagram', 'flowchartX TD\n A --> B', '%% only a comment']) assert.equal(hasMermaidDiagramType(code), false, code)
})

test('注释、空行与指令行不参与首个有效行判定，且保持 12 行窗口', () => {
  assert.equal(hasMermaidDiagramType('%%{init: {"theme": "base"}}%%\n\n%% 说明\nflowchart LR\n A --> B'), true)
  assert.equal(hasMermaidDiagramType(`${Array.from({ length: 12 }, () => '%% 说明').join('\n')}\nflowchart LR\n A --> B`), true)
  assert.equal(hasMermaidDiagramType(`${Array.from({ length: 12 }, (_, i) => `title line ${i}`).join('\n')}\nflowchart LR\n A --> B`), false)
})

test('围栏识别包含 info string、大小写与 CRLF，并给出可切分偏移', () => {
  const content = `# 标题\n\n${fence('flowchart LR\n A --> B', ' title="示例"')}\n\n正文\n`
  const [found] = findMermaidFences(content)
  assert.ok(found)
  assert.equal(found.code.trimEnd(), 'flowchart LR\n A --> B')
  assert.equal(content.slice(found.start, found.end), fence('flowchart LR\n A --> B', ' title="示例"'))
  assert.equal(content.slice(0, found.start).endsWith('# 标题\n\n'), true)

  const crlf = '前言\r\n```Mermaid\r\nsequenceDiagram\r\n A->>B: hi\r\n```\r\n后记'
  const [crlfFence] = findMermaidFences(crlf)
  assert.ok(crlfFence)
  assert.equal(crlfFence.code.trimEnd(), 'sequenceDiagram\r\n A->>B: hi')
  assert.equal(hasMermaidDiagramType(crlfFence.code), true)
})

test('未闭合或非行首的围栏保持普通 Markdown', () => {
  assert.equal(findMermaidFences('```mermaid\nflowchart LR\n A --> B').length, 0)
  assert.equal(findMermaidFences('   ```mermaid\nflowchart LR\n   ```').length, 0)
  // 0.7.5 起的规则允许 info string，因此 ```mermaidx 与 ```mermaid title 等价，保持兼容。
  assert.equal(findMermaidFences('```mermaidx\nflowchart LR\n```').length, 1)
})

test('统计函数同时给出围栏总数与有效图数量', () => {
  const content = `${fence('flowchart LR\n A --> B')}\n\n${fence('not a diagram')}\n\n${fence('sequenceDiagram\n A->>B: hi')}`
  assert.deepEqual(mermaidFenceStats(content), { blocks: 3, valid: 2 })
  assert.deepEqual(mermaidFenceStats('没有图'), { blocks: 0, valid: 0 })
})

test('切分把每张有效图独立成段，无效围栏留在 Markdown 中', () => {
  const first = fence('flowchart LR\n A --> B')
  const invalid = fence('not a diagram')
  const second = fence('sequenceDiagram\n  A->>B: call')
  const content = `开头\n\n${first}\n\n中间 ${invalid}\n\n${second}\n\n结尾`
  const segments = splitMermaidDiagrams(content)
  assert.deepEqual(segments.map(segment => segment.kind), ['markdown', 'mermaid', 'markdown', 'mermaid', 'markdown'])
  assert.deepEqual(segments.filter(segment => segment.kind === 'mermaid').map(segment => segment.kind === 'mermaid' && segment.code.trimEnd()), ['flowchart LR\n A --> B', 'sequenceDiagram\n  A->>B: call'])
  const roundTrip = segments.map(segment => segment.kind === 'markdown' ? segment.text : segment.raw).join('')
  assert.equal(roundTrip, content)
  assert.match(segments[2]?.kind === 'markdown' ? segments[2].text : '', /not a diagram/)
})

test('没有有效图时保持单个 Markdown 片段', () => {
  assert.deepEqual(splitMermaidDiagrams('# 纯文本\n\n没有图'), [{ kind: 'markdown', text: '# 纯文本\n\n没有图' }])
  assert.deepEqual(splitMermaidDiagrams(''), [{ kind: 'markdown', text: '' }])
})

const palette: MermaidPalette = {
  background: '#ffffff', layer1: '#f7f7f8', layer2: '#ececf0', border1: '#e4e4e8', border2: '#cfcfd6',
  brand: '#4d6bfe', text: '#1a1a1c', secondaryText: '#5b5b66', error: '#d92d20', warn: '#cc8330',
}

test('主题变量取自宿主语义颜色，并随深浅色与字体变化', () => {
  const light = buildMermaidTheme(palette, 'sans-serif', false)
  assert.equal(light.options.variables.primaryColor, '#ececf0')
  assert.equal(light.options.variables.primaryTextColor, '#1a1a1c')
  assert.equal(light.options.variables.actorBorder, '#4d6bfe')
  assert.equal(light.options.variables.darkMode, false)
  assert.equal(light.options.fontFamily, 'sans-serif')
  const dark = buildMermaidTheme({ ...palette, background: '#111111', layer1: '#17171a' }, 'serif', true)
  assert.equal(dark.options.variables.darkMode, true)
  assert.equal(dark.options.variables.background, '#17171a')
  assert.notEqual(light.signature, dark.signature)
  assert.equal(themeSignature(light.options), light.signature)
})

test('质量门禁复用共享判定，并逐块报告无效 Mermaid', () => {
  const source = (path: string): SourceExcerpt => ({ id: path.padEnd(32, '0').slice(0, 32), path, startLine: 1, endLine: 10, hash: 'hash', version: 'v1', text: 'export const value = 1' })
  const sources = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(source)
  const content = ['# 架构', '', '说明。', '', '## 组件', '', '`src/a.ts:L1`', '', '正文说明。'.repeat(220), '', '## 数据流', '', fence('flowchart LR\n A --> B'), '', fence('not a diagram')].join('\n')
  const result = evaluatePage({ id: 'architecture', kind: 'page', type: 'architecture', parentId: null, title: '架构', summary: '架构', relatedPaths: ['src/a.ts'] }, content, sources, sources.map(item => item.path))
  assert.equal(result.mermaid, mermaidFenceStats(content).valid)
  assert.doesNotMatch(result.soft.join('；'), /Mermaid 关系图不足/)
  assert.match(result.soft.join('；'), /缺少有效图类型/)
})

test('包含有效 Mermaid 图的 details 折叠块保持整体切分', () => {
  const md = [
    '# 模块说明',
    '',
    '正文段落。',
    '',
    '<details>',
    '<summary>代码结构参考（自动解析）</summary>',
    '',
    '> 自动解析。',
    '',
    fence('flowchart TD\n  A --> B'),
    '',
    '</details>',
  ].join('\n')
  const segments = splitMermaidDiagrams(md)
  assert.equal(segments.length, 2)
  assert.equal(segments[0]!.kind, 'markdown')
  assert.equal(segments[1]!.kind, 'details')
  if (segments[1]!.kind === 'details') {
    assert.equal(segments[1]!.summary, '代码结构参考（自动解析）')
    assert.equal(segments[1]!.segments.some(child => child.kind === 'mermaid'), true)
  }
})
