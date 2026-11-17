import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeWithTypeScript, callGraphWithTypeScript, loadTypeScript, resetTypeScriptCache } from '../src/host/ast-ts.js'
import { structureDiagram } from '../src/host/ast-flow.js'
import type { Step } from '../src/host/ast-flow.js'

const service = `import { load } from './io.js'
import path from 'node:path'

export async function bootstrap(id: string): Promise<string> {
  if (!id) {
    throw new Error('missing')
  }
  const text = await load(id)
  for (const line of text.split('\\n')) {
    if (line.startsWith('#')) continue
  }
  try {
    return text.trim()
  } catch (error) {
    throw error
  }
}

export const parse = (input: string) => {
  switch (input.length) {
    case 0:
      return ''
    default:
      return input
  }
}
`

const io = `export async function load(id: string) {
  return id
}
`

const kinds = (steps: Step[]): string[] => steps.map(step => step.kind)

test('TypeScript AST 提取函数、分支、循环与 try/catch', async () => {
  const ts = await loadTypeScript()
  assert.ok(ts, 'typescript 应可加载')
  const flow = analyzeWithTypeScript(ts!, 'src/bootstrap.ts', service)
  assert.deepEqual(flow.functions.map(fn => fn.name).sort(), ['bootstrap', 'parse'])

  const bootstrap = flow.functions.find(fn => fn.name === 'bootstrap')!
  assert.equal(bootstrap.async, true)
  assert.equal(bootstrap.line, 4, '起始行应为函数声明所在行')
  assert.deepEqual(kinds(bootstrap.steps), ['if', 'call', 'loop', 'try'])
  const guard = bootstrap.steps[0]!
  assert.equal(guard.kind, 'if')
  assert.ok(guard.kind === 'if' && guard.then.some(step => step.kind === 'throw'))
  const loop = bootstrap.steps[2]!
  assert.ok(loop.kind === 'loop' && loop.body.some(step => step.kind === 'if'))
  const guardTry = bootstrap.steps[3]!
  assert.ok(guardTry.kind === 'try' && guardTry.handler?.length)

  const parse = flow.functions.find(fn => fn.name === 'parse')!
  assert.ok(parse.steps.some(step => step.kind === 'switch'))
})

test('符号级调用图按导入解析跨文件调用，不把内置模块当作节点', async () => {
  const ts = await loadTypeScript()
  const graph = callGraphWithTypeScript(ts!, [
    { path: 'src/bootstrap.ts', text: service },
    { path: 'src/io.ts', text: io },
  ])
  assert.ok(graph)
  assert.ok(graph.mermaid.startsWith('flowchart LR'))
  assert.ok(graph.edges.some(edge => edge.from.name === 'bootstrap' && edge.from.file === 'src/bootstrap.ts'
    && edge.to.name === 'load' && edge.to.file === 'src/io.ts'), '应解析到跨文件符号')
  assert.ok(!graph.mermaid.includes('node:path'))
  assert.ok(graph.files.includes('src/io.ts'))
})

test('总览页在有 TS 源码时优先输出符号调用图', async () => {
  const diagram = await structureDiagram({
    type: 'overview', language: 'zh',
    files: [{ path: 'src/bootstrap.ts', text: service }, { path: 'src/io.ts', text: io }],
  })
  assert.ok(diagram)
  assert.equal(diagram.kind, 'dependency')
  assert.match(diagram.title, /符号调用图/)
  assert.ok(diagram.mermaid.startsWith('flowchart LR'))
})

test('typescript 不可用时回退到轻量解析器，仍能产出控制流图', async () => {
  resetTypeScriptCache(null)
  try {
    const diagram = await structureDiagram({ type: 'module', language: 'zh', files: [{ path: 'src/bootstrap.ts', text: service }] })
    assert.ok(diagram, '回退路径必须仍产出结构图')
    assert.equal(diagram.kind, 'control-flow')
    assert.ok(diagram.mermaid.startsWith('flowchart TD'))
    assert.ok(diagram.mermaid.includes('-->'))
  } finally {
    resetTypeScriptCache()
  }
})
