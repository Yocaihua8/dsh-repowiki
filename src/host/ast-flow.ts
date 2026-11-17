/**
 * 由源码结构确定性地生成 Mermaid 流程图（Host 侧，不调用模型）。
 *
 * 设计边界：
 * - 解析分两级：优先使用 TypeScript 编译器 AST（`ast-ts.ts`）；`typescript`
 *   不可用或文件不是 TS/JS 时，回退到本文件的轻量解析器（词法切分 + 花括号结构树）。
 *   两条路径产出同一种 `FileFlow`，渲染与注入完全一致。
 * - 未识别的语法降级为普通语句节点，不抛错、不中断生成。
 * - 输出带硬上限（节点数、函数数、文件数），保证图可读且不拖慢渲染。
 * - 这是「确定性结构图」，与模型自由撰写的关系图互补：后者表达设计意图，
 *   前者表达代码事实。
 */

import { analyzeWithTypeScript, callGraphWithTypeScript, isTypeScriptLike, loadTypeScript } from './ast-ts.js'

export const FLOW_LIMITS = Object.freeze({
  /** 单张图最多节点数。 */
  maxNodes: 18,
  /** 单个文件最多参与分析的对象数（函数/方法）。 */
  maxFunctions: 8,
  /** 每个标签最多字符数。 */
  maxLabel: 56,
  /** 单个函数体内最多语句节点数。 */
  maxSteps: 12,
  /** 模块依赖图最多文件节点数。 */
  maxFiles: 10,
})

type TokenKind = 'id' | 'punct' | 'string' | 'number' | 'template' | 'regex'
interface Token { kind: TokenKind; value: string; line: number }

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', ':', '?', '=', '+', '-', '*', '/', '%', '<', '>', '!', '&', '|', '^', '~', '@', '#',
]
const REGEX_PREFIX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return', 'typeof', 'case', 'in', 'of', 'do', 'else', '=>', '&&', '||', '??', '+', '-', '*', '%', '<', '>'])
const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'new', 'await', 'yield', 'typeof', 'void', 'delete', 'instanceof'])

const isIdStart = (ch: string) => /[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) > 0x7f
const isIdPart = (ch: string) => /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 0x7f

/**
 * 词法切分：剥离注释，归一化字符串与模板字面量，保留行号。
 * 正则字面量按「前一个有效 token」判断，误判时最坏退化为除法符号，不影响结构解析。
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0, line = 1
  const push = (kind: TokenKind, value: string) => tokens.push({ kind, value, line })
  const lastSignificant = () => tokens.at(-1)

  while (index < source.length) {
    const ch = source[index]!
    if (ch === '\n') { line++; index++; continue }
    if (/\s/.test(ch)) { index++; continue }

    if (ch === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) { if (source[index] === '\n') line++; index++ }
      index += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      const startLine = line
      let value = ''
      index++
      while (index < source.length && source[index] !== ch) {
        if (source[index] === '\\') { value += source[index + 1] ?? ''; index += 2; continue }
        if (source[index] === '\n') line++
        value += source[index]
        index++
      }
      index++
      push('string', value)
      tokens.at(-1)!.line = startLine
      continue
    }
    if (ch === '`') {
      const startLine = line
      let value = '', depth = 0
      index++
      while (index < source.length) {
        const current = source[index]!
        if (current === '\\') { value += source[index + 1] ?? ''; index += 2; continue }
        if (current === '\n') line++
        if (current === '$' && source[index + 1] === '{') { depth++; index += 2; continue }
        if (current === '}' && depth > 0) { depth--; index++; continue }
        if (current === '`' && depth === 0) { index++; break }
        value += current
        index++
      }
      push('template', value)
      tokens.at(-1)!.line = startLine
      continue
    }
    if (ch === '/' && regexAllowed(lastSignificant())) {
      const startLine = line
      let value = ''
      index++
      let closed = false
      while (index < source.length) {
        const current = source[index]!
        if (current === '\\') { value += source[index + 1] ?? ''; index += 2; continue }
        if (current === '\n') break
        if (current === '/') { closed = true; index++; break }
        value += current
        index++
      }
      if (!closed) { push('punct', '/'); continue }
      while (index < source.length && /[a-z]/i.test(source[index]!)) index++
      push('regex', value)
      tokens.at(-1)!.line = startLine
      continue
    }
    if (/[0-9]/.test(ch)) {
      let value = ''
      while (index < source.length && /[0-9a-fA-FxXoObBnN._]/.test(source[index]!)) { value += source[index]; index++ }
      push('number', value)
      continue
    }
    if (isIdStart(ch)) {
      let value = ''
      while (index < source.length && isIdPart(source[index]!)) { value += source[index]; index++ }
      push('id', value)
      continue
    }
    const punct = PUNCTUATORS.find(candidate => source.startsWith(candidate, index))
    if (punct) { push('punct', punct); index += punct.length; continue }
    index++
  }
  return tokens
}

function regexAllowed(previous: Token | undefined): boolean {
  if (!previous) return true
  if (previous.kind === 'id') return REGEX_PREFIX.has(previous.value) || KEYWORDS.has(previous.value)
  if (previous.kind === 'punct') return REGEX_PREFIX.has(previous.value)
  return false
}

/** 控制结构树。`steps` 只保留参与画图的关键节点。 */
export type Step =
  | { kind: 'call'; label: string }
  | { kind: 'return'; label: string }
  | { kind: 'throw'; label: string }
  | { kind: 'if'; label: string; then: Step[]; otherwise: Step[] | null }
  | { kind: 'loop'; label: string; body: Step[] }
  | { kind: 'switch'; label: string; body: Step[] }
  | { kind: 'try'; body: Step[]; handler: Step[] | null }

export interface FlowFunction { name: string; line: number; steps: Step[]; async: boolean }
export interface FileFlow { path: string; functions: FlowFunction[]; imports: string[] }

export const label = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > FLOW_LIMITS.maxLabel ? `${collapsed.slice(0, FLOW_LIMITS.maxLabel - 1)}…` : collapsed
}
export const escapeLabel = (text: string): string => `"${label(text).replace(/"/g, "'")}"`

/** 括号配对：返回与 `open` 处左括号匹配的右括号下标。 */
function matchBracket(tokens: Token[], open: number): number {
  const opener = tokens[open]?.value
  const closer = opener === '(' ? ')' : opener === '{' ? '}' : opener === '[' ? ']' : ''
  if (!closer) return -1
  let depth = 0
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index]!.value === opener) depth++
    else if (tokens[index]!.value === closer) { depth--; if (depth === 0) return index }
  }
  return -1
}

/** 把 token 序列还原成可读代码片段：字符串补引号，去掉成员访问与括号内的多余空格。 */
function renderTokens(tokens: Token[]): string {
  return tokens
    .map(token => token.kind === 'string' ? `'${token.value}'` : token.kind === 'template' ? `\`${token.value}\`` : token.value)
    .join(' ')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s*\[\s*/g, '[')
    .replace(/\s*\]/g, ']')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s*:\s*/g, ': ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 读取 `(` 到 `)` 之间的条件文本，去掉外层括号。 */
function readCondition(tokens: Token[], open: number): { text: string; end: number } {
  const close = matchBracket(tokens, open)
  if (close < 0) return { text: '', end: open }
  return { text: renderTokens(tokens.slice(open + 1, close)), end: close }
}

/** 读取一条语句的浅层文本（到分号或块结束），用于 return/throw/call 标签。 */
function readStatement(tokens: Token[], start: number, stop: number): string {
  const parts: Token[] = []
  let depth = 0
  for (let index = start; index < stop; index++) {
    const token = tokens[index]!
    if (token.value === '(' || token.value === '[' || token.value === '{') depth++
    else if (token.value === ')' || token.value === ']' || token.value === '}') { if (depth === 0) break; depth-- }
    if (depth === 0 && (token.value === ';' || token.value === ',')) break
    parts.push(token)
  }
  return renderTokens(parts)
}

/**
 * 找到函数体起始 `{`：跳过返回类型中的对象字面量类型
 * （如 `): { path: string } | null {` 里被 `|`/`&` 跟随的花括号），
 * 遇到 `;` 或箭头即判定「不是函数体」，避免把普通调用误认成方法。
 */
function findBodyBrace(tokens: Token[], from: number): number {
  for (let cursor = from; cursor < tokens.length; cursor++) {
    const token = tokens[cursor]!
    if (token.value === ';' || token.value === '=>') return -1
    if (token.value !== '{') continue
    const close = matchBracket(tokens, cursor)
    if (close < 0) return -1
    const after = tokens[close + 1]?.value
    if (after === '|' || after === '&') { cursor = close; continue }
    return cursor
  }
  return -1
}

/** 无花括号单语句体：返回该语句的结束位置（分号、外层块结束或换行起始的新语句）。 */
const STATEMENT_STARTERS = new Set(['return', 'throw', 'if', 'for', 'while', 'switch', 'try', 'const', 'let', 'var', 'class', 'function', 'import', 'export', 'do', 'break', 'continue', 'await'])
function statementEnd(tokens: Token[], from: number, stop: number): number {
  let depth = 0
  for (let cursor = from; cursor < stop; cursor++) {
    const token = tokens[cursor]!
    const value = token.value
    if (value === '(' || value === '[' || value === '{') depth++
    else if (value === ')' || value === ']' || value === '}') { if (depth === 0) return cursor; depth-- }
    else if (value === ';' && depth === 0) return cursor
    // 本项目源码不带分号，用「换行 + 语句起始关键字」判断语句边界。
    if (depth === 0 && cursor > from && STATEMENT_STARTERS.has(value) && token.line > tokens[cursor - 1]!.line) return cursor
  }
  return stop
}

/** 类体范围：只有落在类体内的 `name(…)` 才按方法处理。 */
function classRanges(tokens: Token[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]!.value !== 'class') continue
    let cursor = index + 1
    while (cursor < tokens.length && tokens[cursor]!.value !== '{' && tokens[cursor]!.value !== ';') cursor++
    if (tokens[cursor]?.value !== '{') continue
    const close = matchBracket(tokens, cursor)
    if (close > cursor) ranges.push([cursor, close])
  }
  return ranges
}

const METHOD_MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'async', 'readonly', 'override', 'get', 'set', 'abstract', 'declare'])
/** 这些关键字后面跟 `(` 时是控制语句而非方法定义。 */
const METHOD_EXCLUDE = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'throw', 'import', 'super', 'this'])

/** 解析一段语句区间，产出控制结构树。超出步数上限后停止收集，避免图失控。 */
function parseSteps(tokens: Token[], start: number, stop: number, budget = { remaining: FLOW_LIMITS.maxSteps }): Step[] {
  const steps: Step[] = []
  let index = start
  while (index < stop && budget.remaining > 0) {
    const token = tokens[index]!
    const value = token.value
    if (value === 'if' && tokens[index + 1]?.value === '(') {
      const condition = readCondition(tokens, index + 1)
      const thenOpen = condition.end + 1
      const braced = tokens[thenOpen]?.value === '{'
      const thenClose = braced ? matchBracket(tokens, thenOpen) : statementEnd(tokens, thenOpen, stop)
      if (thenClose < 0) break
      const thenSteps = braced ? parseSteps(tokens, thenOpen + 1, thenClose, budget) : parseSteps(tokens, thenOpen, thenClose, budget)
      let otherwise: Step[] | null = null
      let cursor = braced ? thenClose + 1 : thenClose
      if (tokens[cursor]?.value === 'else') {
        if (tokens[cursor + 1]?.value === '{') {
          const elseClose = matchBracket(tokens, cursor + 1)
          if (elseClose < 0) break
          otherwise = parseSteps(tokens, cursor + 2, elseClose, budget)
          cursor = elseClose + 1
        } else if (tokens[cursor + 1]?.value === 'if') {
          otherwise = parseSteps(tokens, cursor + 1, stop, budget)
          cursor = stop
        } else {
          const elseEnd = statementEnd(tokens, cursor + 1, stop)
          otherwise = parseSteps(tokens, cursor + 1, elseEnd, budget)
          cursor = elseEnd
        }
      }
      budget.remaining--
      steps.push({ kind: 'if', label: condition.text || '条件', then: thenSteps, otherwise })
      index = cursor
      continue
    }
    if ((value === 'for' || value === 'while') && tokens[index + 1]?.value === '(') {
      const condition = readCondition(tokens, index + 1)
      const bodyOpen = condition.end + 1
      const braced = tokens[bodyOpen]?.value === '{'
      const bodyClose = braced ? matchBracket(tokens, bodyOpen) : statementEnd(tokens, bodyOpen, stop)
      if (bodyClose < 0) break
      budget.remaining--
      steps.push({ kind: 'loop', label: `${value} ${condition.text}`.trim(), body: braced ? parseSteps(tokens, bodyOpen + 1, bodyClose, budget) : parseSteps(tokens, bodyOpen, bodyClose, budget) })
      index = braced ? bodyClose + 1 : bodyClose
      continue
    }
    if (value === 'switch' && tokens[index + 1]?.value === '(') {
      const condition = readCondition(tokens, index + 1)
      const bodyOpen = condition.end + 1
      if (tokens[bodyOpen]?.value !== '{') { index = bodyOpen; continue }
      const bodyClose = matchBracket(tokens, bodyOpen)
      if (bodyClose < 0) break
      budget.remaining--
      steps.push({ kind: 'switch', label: `switch ${condition.text}`.trim(), body: parseSteps(tokens, bodyOpen + 1, bodyClose, budget) })
      index = bodyClose + 1
      continue
    }
    if (value === 'try' && tokens[index + 1]?.value === '{') {
      const bodyClose = matchBracket(tokens, index + 1)
      if (bodyClose < 0) break
      const body = parseSteps(tokens, index + 2, bodyClose, budget)
      let handler: Step[] | null = null
      let cursor = bodyClose + 1
      if (tokens[cursor]?.value === 'catch') {
        cursor++
        if (tokens[cursor]?.value === '(') cursor = matchBracket(tokens, cursor) + 1
        if (tokens[cursor]?.value === '{') {
          const handlerClose = matchBracket(tokens, cursor)
          if (handlerClose < 0) break
          handler = parseSteps(tokens, cursor + 1, handlerClose, budget)
          cursor = handlerClose + 1
        }
      }
      if (tokens[cursor]?.value === 'finally' && tokens[cursor + 1]?.value === '{') {
        const finallyClose = matchBracket(tokens, cursor + 1)
        if (finallyClose > 0) cursor = finallyClose + 1
      }
      budget.remaining--
      steps.push({ kind: 'try', body, handler })
      index = cursor
      continue
    }
    if (value === 'return' || value === 'throw') {
      budget.remaining--
      steps.push({ kind: value === 'return' ? 'return' : 'throw', label: readStatement(tokens, index, stop) })
      // 跳过本条语句的剩余部分，避免把其中的调用再拆成独立节点。
      index = Math.max(index + 1, statementEnd(tokens, index, stop))
      continue
    }
    // 识别调用语句：形如 `name(` / `obj.name(` / `await name(`
    if (token.kind === 'id' && tokens[index + 1]?.value === '(' && !KEYWORDS.has(value)) {
      const argsEnd = matchBracket(tokens, index + 1)
      if (argsEnd > 0) {
        budget.remaining--
        steps.push({ kind: 'call', label: `${value}()` })
        index = argsEnd + 1
        continue
      }
    }
    if (value === 'await' && tokens[index + 1]?.kind === 'id' && tokens[index + 2]?.value === '(') {
      const argsEnd = matchBracket(tokens, index + 2)
      if (argsEnd > 0) {
        budget.remaining--
        steps.push({ kind: 'call', label: `await ${tokens[index + 1]!.value}()` })
        index = argsEnd + 1
        continue
      }
    }
    index++
  }
  return steps
}

/**
 * 从导入语句收集模块说明符，用于依赖图。
 * 兼容 `import x from '…'`、`import { a, b } from '…'`、`import '…'`、`import('…')`
 * 与 `export … from '…'`；命名导入的花括号不构成语句边界。
 */
function collectImports(tokens: Token[]): string[] {
  const specifiers: string[] = []
  const record = (value: string | undefined) => { if (value && value.startsWith('.')) specifiers.push(value) }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.value === 'import') {
      const next = tokens[index + 1]
      if (next?.kind === 'string') { record(next.value); continue }
      if (next?.value === '(') {
        const literal = tokens[index + 2]
        if (literal?.kind === 'string') record(literal.value)
        continue
      }
      // 命名/默认导入：说明符出现在同一语句的最后一个字符串 token 上。
      for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        const candidate = tokens[cursor]!
        if (candidate.value === ';' || candidate.value === 'import' || candidate.value === 'export') break
        if (candidate.kind === 'string') { record(candidate.value); break }
      }
      continue
    }
    if (token.value === 'from' && tokens[index + 1]?.kind === 'string') record(tokens[index + 1]!.value)
  }
  return [...new Set(specifiers)]
}

/** 扫描文件中的函数与方法定义，返回各自的控制结构树。 */
export function analyzeSource(path: string, source: string): FileFlow {
  const tokens = tokenize(source)
  const functions: FlowFunction[] = []
  const classes = classRanges(tokens)
  const add = (name: string, line: number, bodyOpen: number, async: boolean) => {
    if (functions.length >= FLOW_LIMITS.maxFunctions) return
    const bodyClose = matchBracket(tokens, bodyOpen)
    if (bodyClose < 0) return
    const steps = parseSteps(tokens, bodyOpen + 1, bodyClose)
    // 无任何可画结构的函数（getter、纯转发）不进入候选，避免占用名额。
    if (steps.length === 0) return
    functions.push({ name, line, async, steps })
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.value === 'function') {
      let cursor = index + 1
      if (tokens[cursor]?.value === '*') cursor++
      const name = tokens[cursor]?.kind === 'id' ? tokens[cursor]!.value : 'anonymous'
      if (tokens[cursor]?.kind === 'id') cursor++
      if (tokens[cursor]?.value === '<') while (cursor < tokens.length && tokens[cursor]!.value !== '>') cursor++
      if (tokens[cursor]?.value === '(') {
        const paramsEnd = matchBracket(tokens, cursor)
        if (paramsEnd < 0) continue
        cursor = paramsEnd + 1
      }
      const body = findBodyBrace(tokens, cursor)
      if (body > 0) add(name, token.line, body, isAsync(tokens, index))
      continue
    }
    // 箭头函数：`const name = (…) => {` 或 `const name = async (…) => {`
    // 只接受紧邻的参数形态，避免把 `const x = await f()` 之后的语句误判成参数表。
    if (token.kind === 'id' && ['const', 'let', 'var'].includes(tokens[index - 1]?.value ?? '') && tokens[index + 1]?.value === '=') {
      let cursor = index + 2
      const async = tokens[cursor]?.value === 'async'
      if (async) cursor++
      if (tokens[cursor]?.value === '(') cursor = matchBracket(tokens, cursor) + 1
      else if (tokens[cursor]?.kind === 'id') cursor++
      else continue
      if (cursor <= 0 || tokens[cursor]?.value !== '=>') continue
      cursor++
      if (tokens[cursor]?.value === '{') add(token.value, token.line, cursor, async)
      continue
    }
    // 类方法：`name(…) {`、`async name(…) {`、`private name(…): T {`
    // 只认落在类体内的成员，避免把函数体内的普通调用误判成方法定义。
    if (token.kind === 'id' && tokens[index + 1]?.value === '(' && !METHOD_EXCLUDE.has(token.value)) {
      const owner = classes.find(([start, end]) => index > start && index < end)
      if (owner) {
        let back = index - 1
        while (back > owner[0] && METHOD_MODIFIERS.has(tokens[back]!.value)) back--
        const before = tokens[back]?.value
        if (before === '{' || before === '}' || before === ';') {
          const paramsEnd = matchBracket(tokens, index + 1)
          if (paramsEnd > 0) {
            const body = findBodyBrace(tokens, paramsEnd + 1)
            if (body > 0 && body < owner[1]) add(token.value, token.line, body, isAsync(tokens, index))
          }
        }
      }
    }
  }
  return { path, functions, imports: collectImports(tokens) }
}

function isAsync(tokens: Token[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0 && cursor >= index - 3; cursor--) {
    if (tokens[cursor]!.value === 'async') return true
    if (tokens[cursor]!.value === ';' || tokens[cursor]!.value === '}') return false
  }
  return false
}

/**
 * 把控制结构树渲染成 flowchart 定义（不含围栏）。
 * 所有 return/throw 汇入同一个结束节点；返回语句之后的语句不会连到结束节点上，
 * 而是接回产生该分支的判断节点，保持「可达路径」正确。
 */
export function renderSteps(steps: Step[], startLabel: string): { lines: string[]; nodes: number } {
  const lines: string[] = []
  let sequence = 0
  const next = () => `n${sequence++}`
  const add = (line: string) => lines.push(line)
  const budgetLeft = () => lines.length < FLOW_LIMITS.maxNodes * 3

  const entry = next()
  add(`  ${entry}([${escapeLabel(startLabel)}])`)
  let endNode: string | null = null
  const end = () => {
    endNode ??= next()
    if (!lines.some(line => line.includes(`${endNode}(`))) add(`  ${endNode}([${escapeLabel('结束')}])`)
    return endNode
  }

  interface Tail { tail: string; ended: boolean }

  /** 渲染一个分支；`edgeLabel` 只作用于入口连线，返回值描述该分支的出口与是否终止。 */
  const walk = (items: Step[], from: string, edgeLabel?: string): Tail => {
    let cursor = from
    let pendingLabel = edgeLabel
    let ended = false
    const connect = (to: string) => {
      add(pendingLabel ? `  ${cursor} -->|${pendingLabel}| ${to}` : `  ${cursor} --> ${to}`)
      pendingLabel = undefined
    }
    for (const step of items) {
      if (!budgetLeft()) break
      if (step.kind === 'call') {
        const node = next()
        add(`  ${node}[${escapeLabel(step.label)}]`)
        connect(node)
        cursor = node; ended = false
        continue
      }
      if (step.kind === 'return' || step.kind === 'throw') {
        const node = next()
        add(`  ${node}[/${escapeLabel(step.label)}/]`)
        connect(node)
        add(`  ${node} --> ${end()}`)
        // 终止语句不改变后续语句的入口：后续语句只能从判断节点继续。
        ended = true
        continue
      }
      if (step.kind === 'if') {
        const decision = next()
        add(`  ${decision}{${escapeLabel(step.label)}}`)
        connect(decision)
        const thenTail: Tail = step.then.length ? walk(step.then, decision, '是') : { tail: decision, ended: false }
        const hasElse = !!(step.otherwise && step.otherwise.length)
        const elseTail: Tail = hasElse ? walk(step.otherwise!, decision, '否') : { tail: decision, ended: false }
        if (hasElse && thenTail.ended && elseTail.ended) {
          cursor = decision; ended = true
          continue
        }
        if (hasElse) {
          const join = next()
          add(`  ${thenTail.tail} --> ${join}`)
          add(`  ${elseTail.tail} --> ${join}`)
          cursor = join
        } else {
          // 只有 then 分支：未终止就汇合到 then 出口，终止则后续语句从判断节点（false 路径）继续。
          cursor = thenTail.ended ? decision : thenTail.tail
        }
        ended = false
        continue
      }
      if (step.kind === 'loop') {
        const loop = next()
        add(`  ${loop}{${escapeLabel(step.label)}}`)
        connect(loop)
        const bodyTail = step.body.length ? walk(step.body, loop, '循环').tail : loop
        if (step.body.length) add(`  ${bodyTail} --> ${loop}`)
        cursor = loop; ended = false
        continue
      }
      if (step.kind === 'switch') {
        const decision = next()
        add(`  ${decision}{${escapeLabel(step.label)}}`)
        connect(decision)
        cursor = step.body.length ? walk(step.body, decision).tail : decision
        ended = false
        continue
      }
      if (step.kind === 'try') {
        const guard = next()
        add(`  ${guard}[${escapeLabel('try')}]`)
        connect(guard)
        const bodyTail = walk(step.body, guard)
        if (step.handler?.length) {
          const onError = next()
          add(`  ${onError}{${escapeLabel('抛错？')}}`)
          add(`  ${bodyTail.tail} --> ${onError}`)
          cursor = walk(step.handler, onError, '是').tail
        } else cursor = bodyTail.tail
        ended = false
        continue
      }
    }
    return { tail: cursor, ended }
  }

  const result = walk(steps, entry)
  if (endNode === null && steps.length > 0 && !result.ended) add(`  ${result.tail} --> ${end()}`)
  return { lines, nodes: sequence }
}

export interface StructureDiagram { title: string; mermaid: string; kind: 'control-flow' | 'dependency'; files: string[] }

/**
 * 解析一批文件：优先用 TypeScript 编译器 AST，加载失败或非 TS/JS 时回退到轻量解析器。
 * 两种解析器产出同一种 `FileFlow`，渲染层无感知。
 */
async function analyzeFiles(files: Array<{ path: string; text: string }>): Promise<FileFlow[]> {
  const ts = await loadTypeScript()
  const flows: FileFlow[] = []
  for (const file of files) {
    let flow: FileFlow | null = null
    if (ts && isTypeScriptLike(file.path)) {
      try { flow = analyzeWithTypeScript(ts, file.path, file.text) } catch { flow = null }
    }
    if (!flow || flow.functions.length === 0) {
      try { flow = analyzeSource(file.path, file.text) } catch { flow = null }
    }
    if (flow && flow.functions.length) flows.push(flow)
  }
  return flows
}

/** 选择参与画图的文件：优先该页关联文件中分支最丰富的一个。 */
function pickFile(flows: FileFlow[]): FileFlow | null {
  let best: { flow: FileFlow; score: number } | null = null
  for (const flow of flows) {
    const score = flow.functions.reduce((sum, fn) => sum + branchCount(fn.steps) * 10 + fn.steps.length, 0)
    if (!best || score > best.score) best = { flow, score }
  }
  return best?.flow ?? null
}

/** 统计控制结构树中的分支数量，用于挑选「最值得画」的函数。 */
export function branchCount(steps: Step[]): number {
  let total = 0
  for (const step of steps) {
    if (step.kind === 'if') { total += 1 + branchCount(step.then) + branchCount(step.otherwise ?? []) }
    else if (step.kind === 'loop') total += 1 + branchCount(step.body)
    else if (step.kind === 'switch') total += 1 + branchCount(step.body)
    else if (step.kind === 'try') { total += 1 + branchCount(step.body) + branchCount(step.handler ?? []) }
  }
  return total
}

/** 代表性函数：优先分支最丰富的，其次语句最多的。 */
export function representative(flow: FileFlow): FlowFunction | null {
  const ranked = [...flow.functions].sort((a, b) => branchCount(b.steps) - branchCount(a.steps) || b.steps.length - a.steps.length)
  return ranked[0] ?? null
}

/**
 * 为页面生成确定性结构图。
 * - overview 页优先生成模块依赖图；
 * - 其余页优先给出主文件代表性函数的控制流图；
 * - 材料不足时返回 null，由调用方跳过注入。
 */
export async function structureDiagram(input: {
  type: string | undefined
  files: Array<{ path: string; text: string }>
  language: 'zh' | 'en'
}): Promise<StructureDiagram | null> {
  const { files, type, language } = input
  if (!files.length) return null
  const zh = language === 'zh'
  const dependency = (): StructureDiagram | null => {
    const graph = dependencyMermaid(files, zh)
    return graph ? { title: zh ? '模块依赖（Host 生成）' : 'Module dependencies (Host-generated)', mermaid: graph.mermaid, kind: 'dependency', files: graph.files } : null
  }

  if (type === 'overview') {
    // 总览页优先给出符号级调用图（函数为节点、跨文件调用为边）；
    // 没有可解析的调用关系时退回文件级依赖图。
    const ts = await loadTypeScript()
    if (ts) {
      try {
        const graph = callGraphWithTypeScript(ts, files.filter(file => isTypeScriptLike(file.path)))
        if (graph) return { title: zh ? '符号调用图（Host 生成）' : 'Symbol call graph (Host-generated)', mermaid: graph.mermaid, kind: 'dependency', files: graph.files }
      } catch { /* 回退到依赖图 */ }
    }
    const fallback = dependency()
    if (fallback) return fallback
  }

  const picked = pickFile(await analyzeFiles(files))
  if (!picked) return dependency()
  const fn = representative(picked)
  if (!fn || fn.steps.length === 0) return dependency()
  const { lines } = renderSteps(fn.steps, `${picked.path} · ${fn.name}`)
  const mermaid = ['flowchart TD', ...lines].join('\n')
  return {
    title: zh ? `控制流：${picked.path} · ${fn.name}（Host 生成）` : `Control flow: ${picked.path} · ${fn.name} (Host-generated)`,
    mermaid, kind: 'control-flow', files: [picked.path],
  }
}

/** 依据相对导入构建文件级依赖图。 */
export function dependencyMermaid(files: Array<{ path: string; text: string }>, zh = true): { mermaid: string; files: string[] } | null {
  const known = new Set(files.map(file => file.path))
  const resolveImport = (from: string, specifier: string): string | null => {
    const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
    const joined = joinPosix(base, specifier)
    // ESM 在 TS 源码里按 '.js' 书写、实际解析到 '.ts'，两种写法都要命中。
    const swapped = joined.replace(/\.(m?js|jsx)$/, (_match, extension: string) => extension === 'jsx' ? '.tsx' : extension === 'mjs' ? '.mts' : '.ts')
    for (const candidate of [joined, swapped, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}.mjs`, `${joined}/index.ts`, `${joined}/index.js`]) {
      if (known.has(candidate)) return candidate
    }
    return null
  }
  const edges: Array<[string, string]> = []
  const involved = new Set<string>()
  for (const file of files.slice(0, FLOW_LIMITS.maxFiles)) {
    let imports: string[]
    try { imports = analyzeSource(file.path, file.text).imports } catch { continue }
    for (const specifier of imports) {
      const target = resolveImport(file.path, specifier)
      if (!target || target === file.path) continue
      edges.push([file.path, target]); involved.add(file.path); involved.add(target)
    }
  }
  if (!edges.length) return null
  const nodes = [...involved].slice(0, FLOW_LIMITS.maxFiles)
  const id = new Map(nodes.map((path, index) => [path, `f${index}`]))
  const lines = ['flowchart LR']
  for (const path of nodes) lines.push(`  ${id.get(path)}[${escapeLabel(shortPath(path))}]`)
  for (const [from, to] of edges) {
    if (!id.has(from) || !id.has(to)) continue
    lines.push(`  ${id.get(from)} --> ${id.get(to)}`)
  }
  return { mermaid: lines.join('\n'), files: nodes }
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length <= 2 ? path : parts.slice(-2).join('/')
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

/**
 * 为一批页面注入确定性结构图（就地修改 content）。
 *
 * 取该页实际读取过的文件（`related`，回退到 `sources`）作为材料。返回实际注入的页数。
 */
export async function augmentPages(
  pages: Array<{ id: string; related?: string[] | undefined; sources?: Array<{ path: string }> | undefined; content: string }>,
  files: Array<{ path: string; text: string }>,
  language: 'zh' | 'en',
  typeOf?: (id: string) => string | undefined,
): Promise<number> {
  if (!files.length) return 0
  const byPath = new Map(files.map(file => [file.path, file.text]))
  let injected = 0
  for (const page of pages) {
    if (!page.content.trim()) continue
    const wanted = [...new Set([...(page.related ?? []), ...(page.sources ?? []).map(source => source.path)])]
    const material = wanted.flatMap(path => {
      const text = byPath.get(path)
      return text === undefined ? [] : [{ path, text }]
    }).slice(0, FLOW_LIMITS.maxFiles)
    if (!material.length) continue
    const diagram = await structureDiagram({ type: typeOf?.(page.id), language, files: material })
    if (!diagram) continue
    page.content = injectStructureBlock(page.content, diagram, language)
    injected++
  }
  return injected
}

const HOST_HEADING = { zh: '代码结构（Host 生成）', en: 'Code structure (Host-generated)' }
const HOST_NOTE = {
  zh: '> 本节由 Host 直接解析源码结构生成，未经模型改写；模型撰写的关系图见正文。',
  en: '> Generated by the Host directly from source structure. Model-authored diagrams appear in the body.',
}

/**
 * 把结构图注入页面 Markdown：紧跟一级标题后的引言之后。
 * 已有同名小节时跳过，保证重复发布幂等。
 */
export function injectStructureBlock(content: string, diagram: StructureDiagram, language: 'zh' | 'en'): string {
  const heading = `## ${HOST_HEADING[language]}`
  if (content.includes(heading)) return content
  const block = [heading, '', HOST_NOTE[language], '', '```mermaid', diagram.mermaid, '```'].join('\n')
  const lines = content.split('\n')
  let insertAt = 0
  for (let index = 0; index < lines.length; index++) {
    if (/^#\s+\S/.test(lines[index]!)) { insertAt = index + 1; break }
  }
  if (insertAt === 0) return `${block}\n\n${content.trimStart()}`
  // 越过一级标题后的空行与首段引言，让结构图位于导语之后、正文之前。
  let cursor = insertAt
  while (cursor < lines.length && lines[cursor]!.trim() === '') cursor++
  while (cursor < lines.length && lines[cursor]!.trim() !== '' && !/^#{1,6}\s/.test(lines[cursor]!)) cursor++
  const head = lines.slice(0, cursor).join('\n').replace(/\s+$/, '')
  const tail = lines.slice(cursor).join('\n').replace(/^\s+/, '')
  // 标题前必须有空行，否则会并入上一段或列表项。
  return tail === '' ? `${head}\n\n${block}` : `${head}\n\n${block}\n\n${tail}`
}
