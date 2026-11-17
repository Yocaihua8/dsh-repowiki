/**
 * 基于 TypeScript 编译器 AST 的结构提取。
 *
 * 与 `ast-flow.ts` 的关系：
 * - 本模块只负责「解析 TS/JS 源码 → 控制结构树 / 符号级调用图」，不做渲染；
 * - 渲染、注入、上限仍由 `ast-flow.ts` 负责，两种解析器产出同一种 `FileFlow`；
 * - `typescript` 为运行时依赖，但按需动态加载：加载失败或源码不是 TS/JS 时，
 *   调用方回退到 `ast-flow.ts` 的轻量解析器，功能降级但不中断生成。
 *
 * 注意：`ts.SyntaxKind` 是数值枚举且存在别名（`VariableStatement` 与
 * `FirstStatement` 同值），字符串反查会拿到别名。因此这里一律用数值比较。
 */
import type { FileFlow, FlowFunction, Step } from './ast-flow.js'
import { escapeLabel, FLOW_LIMITS, label } from './ast-flow.js'

type Ts = typeof import('typescript')
type AnyNode = { kind: number; [key: string]: unknown }

let cached: Ts | null | undefined
/** 首次调用加载 TypeScript；不可用时返回 null 并记住结果，避免反复尝试。 */
export async function loadTypeScript(): Promise<Ts | null> {
  if (cached !== undefined) return cached
  try { cached = (await import('typescript')) as unknown as Ts } catch { cached = null }
  return cached
}

/** 仅测试用：注入一个假的 TypeScript 模块或清空缓存。 */
export function resetTypeScriptCache(value?: Ts | null): void {
  cached = value === undefined ? undefined : value
}

const asNode = (value: unknown): AnyNode | null =>
  (value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'number' ? value as AnyNode : null)

/** 把 TS 节点文本压成一行标签。 */
function textOf(node: unknown, sourceFile: unknown): string {
  const target = asNode(node)
  if (!target) return 'node'
  const getText = target.getText
  if (typeof getText !== 'function') return 'node'
  try { return label((getText as (sourceFile?: unknown) => string).call(target, sourceFile)) } catch { return 'node' }
}

interface Budget { remaining: number }

/** 表达式里第一个调用（穿透 await 与括号），用于 `const x = await f()`。 */
function firstCall(ts: Ts, node: unknown): unknown {
  const target = asNode(node)
  if (!target) return null
  if (target.kind === ts.SyntaxKind.CallExpression) return target
  if (target.kind === ts.SyntaxKind.AwaitExpression || target.kind === ts.SyntaxKind.ParenthesizedExpression) return firstCall(ts, target.expression)
  return null
}

/** 块、单条语句或 case 子句统一按语句数组处理。 */
function asBlock(ts: Ts, value: unknown, sourceFile: unknown, budget: Budget): Step[] {
  const node = asNode(value)
  if (!node) return []
  const { SyntaxKind: K } = ts
  if (node.kind === K.Block || node.kind === K.ModuleBlock) return stepsFromStatements(ts, (node.statements as readonly unknown[] | undefined) ?? [], sourceFile, budget)
  if (node.kind === K.CaseBlock) {
    const clauses = (node.clauses as readonly { statements?: readonly unknown[] }[] | undefined) ?? []
    return clauses.flatMap(clause => stepsFromStatements(ts, clause.statements ?? [], sourceFile, budget))
  }
  if (node.kind === K.CaseClause || node.kind === K.DefaultClause) return stepsFromStatements(ts, (node.statements as readonly unknown[] | undefined) ?? [], sourceFile, budget)
  return stepsFromStatements(ts, [value], sourceFile, budget)
}

/**
 * TS 语句列表 → 控制结构树。
 * 只保留参与画图的节点：分支、循环、switch、try、返回/抛出、调用。
 */
function stepsFromStatements(ts: Ts, statements: readonly unknown[], sourceFile: unknown, budget: Budget): Step[] {
  const steps: Step[] = []
  const { SyntaxKind: K } = ts
  for (const raw of statements) {
    if (budget.remaining <= 0) break
    const node = asNode(raw)
    if (!node) continue

    if (node.kind === K.IfStatement) {
      budget.remaining--
      const thenSteps = asBlock(ts, node.thenStatement, sourceFile, budget)
      const elseSteps = node.elseStatement ? asBlock(ts, node.elseStatement, sourceFile, budget) : null
      steps.push({ kind: 'if', label: textOf(node.expression, sourceFile) || '条件', then: thenSteps, otherwise: elseSteps })
      continue
    }
    if (node.kind === K.ForStatement || node.kind === K.ForOfStatement || node.kind === K.ForInStatement || node.kind === K.WhileStatement || node.kind === K.DoStatement) {
      budget.remaining--
      const isForOf = node.kind === K.ForOfStatement || node.kind === K.ForInStatement
      const header = isForOf ? textOf(node.initializer, sourceFile) : textOf(node.condition ?? node.expression ?? node, sourceFile)
      const keyword = node.kind === K.WhileStatement ? 'while' : node.kind === K.DoStatement ? 'do' : 'for'
      steps.push({ kind: 'loop', label: `${keyword} ${header}`.trim(), body: asBlock(ts, node.statement, sourceFile, budget) })
      continue
    }
    if (node.kind === K.SwitchStatement) {
      budget.remaining--
      steps.push({ kind: 'switch', label: `switch ${textOf(node.expression, sourceFile)}`, body: asBlock(ts, node.caseBlock, sourceFile, budget) })
      continue
    }
    if (node.kind === K.TryStatement) {
      budget.remaining--
      const catchClause = asNode(node.catchClause)
      steps.push({ kind: 'try', body: asBlock(ts, node.tryBlock, sourceFile, budget), handler: catchClause ? asBlock(ts, catchClause.block, sourceFile, budget) : null })
      continue
    }
    if (node.kind === K.ReturnStatement || node.kind === K.ThrowStatement) {
      budget.remaining--
      steps.push({ kind: node.kind === K.ReturnStatement ? 'return' : 'throw', label: textOf(node, sourceFile) })
      continue
    }
    if (node.kind === K.VariableStatement) {
      // 只看初始化里的调用，例如 `const x = await f()`。
      const declarations = (node.declarationList as { declarations?: readonly unknown[] } | undefined)?.declarations ?? []
      for (const declaration of declarations) {
        const call = firstCall(ts, (declaration as { initializer?: unknown }).initializer)
        if (!call) continue
        budget.remaining--
        steps.push({ kind: 'call', label: textOf(call, sourceFile) })
        break
      }
      continue
    }
    if (node.kind === K.ExpressionStatement) {
      const call = firstCall(ts, node.expression)
      if (!call) continue
      budget.remaining--
      steps.push({ kind: 'call', label: textOf(call, sourceFile) })
    }
  }
  return steps
}

/** 判定文件是否适合用 TS 解析器处理。 */
export function isTypeScriptLike(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path)
}

function scriptKindOf(ts: Ts, path: string): import('typescript').ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function hasAsyncModifier(ts: Ts, node: AnyNode): boolean {
  const modifiers = node.modifiers as readonly { kind: number }[] | undefined
  return (modifiers ?? []).some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
}

function nameOf(node: unknown, sourceFile: unknown): string | undefined {
  const named = asNode(node)?.name as { getText?: (sourceFile?: unknown) => string } | undefined
  return named?.getText?.(sourceFile)
}

function isFunctionInitializer(ts: Ts, node: unknown): boolean {
  const initializer = asNode(asNode(node)?.initializer)
  return !!initializer && (initializer.kind === ts.SyntaxKind.ArrowFunction || initializer.kind === ts.SyntaxKind.FunctionExpression)
}

/** 用 TypeScript AST 提取函数与控制结构。 */
export function analyzeWithTypeScript(ts: Ts, path: string, source: string): FileFlow {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindOf(ts, path))
  const functions: FlowFunction[] = []
  const imports: string[] = []
  const { SyntaxKind: K } = ts

  const declare = (name: string, bodyOwner: AnyNode) => {
    if (functions.length >= FLOW_LIMITS.maxFunctions) return
    const body = asNode(bodyOwner.body) ?? asNode(bodyOwner.initializer)
    if (!body) return
    const steps = asBlock(ts, body, sourceFile, { remaining: FLOW_LIMITS.maxSteps })
    if (!steps.length) return
    const getStart = bodyOwner.getStart
    const start = typeof getStart === 'function' ? (getStart as (sourceFile?: unknown) => number).call(bodyOwner, sourceFile) : 0
    const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1
    functions.push({ name, line, async: hasAsyncModifier(ts, bodyOwner), steps })
  }

  const visit = (raw: unknown) => {
    const node = asNode(raw)
    if (!node) return
    if (node.kind === K.FunctionDeclaration || node.kind === K.MethodDeclaration || node.kind === K.Constructor) {
      declare(node.kind === K.Constructor ? 'constructor' : nameOf(node, sourceFile) ?? 'anonymous', node)
      if (node.body) visit(node.body)
      return
    }
    if (node.kind === K.ArrowFunction || node.kind === K.FunctionExpression) {
      declare(nameOf(node, sourceFile) ?? 'callback', node)
      return
    }
    if (node.kind === K.VariableDeclaration && isFunctionInitializer(ts, node)) {
      declare(nameOf(node, sourceFile) ?? 'anonymous', asNode(node.initializer)!)
      return
    }
    if (node.kind === K.ImportDeclaration) {
      const specifier = (node.moduleSpecifier as { text?: string } | undefined)?.text
      if (specifier?.startsWith('.')) imports.push(specifier)
    }
    // 只下潜到声明与语句层：进入函数体后不再登记内部回调，避免名字爆炸。
    for (const key of ['statements', 'declarationList', 'declarations']) {
      const value = node[key]
      if (Array.isArray(value)) for (const child of value) visit(child)
      else if (value && typeof value === 'object') visit(value)
    }
  }

  visit(sourceFile)
  return { path, functions, imports: [...new Set(imports)] }
}

interface SymbolTable {
  local: Set<string>
  imported: Map<string, { file: string; name: string }>
}

function joinPosix(base: string, specifier: string): string {
  const segments = `${base}/${specifier}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

/** ESM 在 TS 源码里按 '.js' 书写、实际解析到 '.ts'，两种写法都要命中。 */
function resolveRelative(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  const joined = joinPosix(base, specifier)
  const swapped = joined.replace(/\.(m?js|jsx)$/, (_match, extension: string) => extension === 'jsx' ? '.tsx' : extension === 'mjs' ? '.mts' : '.ts')
  for (const candidate of [joined, swapped, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}/index.ts`, `${joined}/index.js`]) {
    if (known.has(candidate)) return candidate
  }
  return null
}

/** 建立「文件 → 本地函数表 / 导入符号表」。 */
function buildSymbols(ts: Ts, files: Array<{ path: string; text: string }>): Map<string, SymbolTable> {
  const { SyntaxKind: K } = ts
  const known = new Set(files.map(file => file.path))
  const tables = new Map<string, SymbolTable>()
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindOf(ts, file.path))
    const local = new Set<string>()
    const imported = new Map<string, { file: string; name: string }>()
    for (const raw of sourceFile.statements) {
      const node = asNode(raw)
      if (!node) continue
      if (node.kind === K.ImportDeclaration) {
        const specifier = (node.moduleSpecifier as { text?: string } | undefined)?.text ?? ''
        if (!specifier.startsWith('.')) continue
        const target = resolveRelative(file.path, specifier, known)
        if (!target) continue
        const bindings = (node.importClause as { namedBindings?: { elements?: readonly unknown[] } } | undefined)?.namedBindings?.elements ?? []
        for (const binding of bindings) {
          const name = nameOf(binding, sourceFile)
          if (name) imported.set(name, { file: target, name })
        }
        continue
      }
      if (node.kind === K.FunctionDeclaration) {
        const name = nameOf(node, sourceFile)
        if (name) local.add(name)
        continue
      }
      if (node.kind === K.VariableStatement) {
        for (const declaration of (node.declarationList as { declarations?: readonly unknown[] }).declarations ?? []) {
          const name = nameOf(declaration, sourceFile)
          if (name && isFunctionInitializer(ts, declaration)) local.add(name)
        }
      }
    }
    tables.set(file.path, { local, imported })
  }
  return tables
}

export interface CallEdge { from: { file: string; name: string }; to: { file: string; name: string } }

/**
 * 符号级调用图：节点是「文件 · 函数」，边是解析后的调用关系。
 * 只解析同文件本地函数与相对导入的命名导出；无法解析的调用忽略，不猜测。
 */
export function callGraphWithTypeScript(ts: Ts, files: Array<{ path: string; text: string }>): { mermaid: string; files: string[]; edges: CallEdge[] } | null {
  const { SyntaxKind: K } = ts
  const subset = files.slice(0, FLOW_LIMITS.maxFiles)
  const symbols = buildSymbols(ts, subset)
  const edges: CallEdge[] = []
  const nodes = new Set<string>()

  for (const file of subset) {
    const table = symbols.get(file.path)
    if (!table) continue
    const sourceFile = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindOf(ts, file.path))
    const owners: Array<{ name: string; body: unknown }> = []
    for (const raw of sourceFile.statements) {
      const node = asNode(raw)
      if (!node) continue
      if (node.kind === K.FunctionDeclaration) {
        const name = nameOf(node, sourceFile)
        if (name) owners.push({ name, body: node.body })
        continue
      }
      if (node.kind === K.VariableStatement) {
        for (const declaration of (node.declarationList as { declarations?: readonly unknown[] }).declarations ?? []) {
          const name = nameOf(declaration, sourceFile)
          if (name && isFunctionInitializer(ts, declaration)) owners.push({ name, body: (declaration as { initializer?: unknown }).initializer })
        }
      }
    }
    for (const owner of owners) {
      const walk = (raw: unknown) => {
        const node = asNode(raw)
        if (!node) return
        if (node.kind === K.CallExpression) {
          const callee = asNode(node.expression)
          const calleeName = callee && callee.kind === K.Identifier ? String(callee.text ?? '') : ''
          if (calleeName) {
            const crossFile = table.imported.get(calleeName)
            if (crossFile) {
              nodes.add(`${file.path}::${owner.name}`); nodes.add(`${crossFile.file}::${crossFile.name}`)
              edges.push({ from: { file: file.path, name: owner.name }, to: { file: crossFile.file, name: crossFile.name } })
            } else if (table.local.has(calleeName) && calleeName !== owner.name) {
              nodes.add(`${file.path}::${owner.name}`); nodes.add(`${file.path}::${calleeName}`)
              edges.push({ from: { file: file.path, name: owner.name }, to: { file: file.path, name: calleeName } })
            }
          }
        }
        for (const key of ['expression', 'statements', 'declarationList', 'declarations', 'body', 'initializer', 'thenStatement', 'elseStatement', 'statement', 'tryBlock', 'catchClause', 'block', 'caseBlock', 'clauses', 'arguments', 'left', 'right', 'condition', 'incrementor']) {
          const value = node[key]
          if (Array.isArray(value)) for (const child of value) walk(child)
          else if (value && typeof value === 'object') walk(value)
        }
      }
      walk(owner.body)
    }
  }

  const unique = [...new Map(edges.map(edge => [`${edge.from.file}::${edge.from.name}->${edge.to.file}::${edge.to.name}`, edge])).values()]
  if (!unique.length) return null
  const ordered = [...nodes].slice(0, FLOW_LIMITS.maxFiles)
  const ids = new Map(ordered.map((key, index) => [key, `c${index}`]))
  const lines = ['flowchart LR']
  for (const key of ordered) {
    const [file, name] = key.split('::') as [string, string]
    lines.push(`  ${ids.get(key)}[${escapeLabel(`${shortPath(file)} · ${name}`)}]`)
  }
  for (const edge of unique) {
    const from = ids.get(`${edge.from.file}::${edge.from.name}`)
    const to = ids.get(`${edge.to.file}::${edge.to.name}`)
    if (from && to && from !== to) lines.push(`  ${from} --> ${to}`)
  }
  if (lines.length === 1) return null
  return { mermaid: lines.join('\n'), files: [...new Set(unique.flatMap(edge => [edge.from.file, edge.to.file]))], edges: unique }
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length <= 2 ? path : parts.slice(-2).join('/')
}
