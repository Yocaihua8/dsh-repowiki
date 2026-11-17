/**
 * Mermaid 运行时 chunk。
 *
 * 这个文件只在页面第一次遇到有效 Mermaid 图时，由主包通过
 * `require.async('./client.mermaid.js')` 加载，因此 mermaid 本体（及其图表
 * 解析器）不会进入插件初始 bundle。导出面保持很小：渲染与校验。
 */
import mermaid from 'mermaid'
import type { MermaidRuntime, MermaidThemeOptions } from './mermaid-types.js'

/** Mermaid 的 initialize/render 共享全局配置，用串行队列保证多图与切换主题时互不覆盖。 */
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task)
  queue = result.then(() => undefined, () => undefined)
  return result
}

function configure(options: MermaidThemeOptions): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    // v12.2 的每种图默认 look 是 neo（带投影滤镜），显式 classic 以跟随宿主平面配色。
    look: 'classic',
    // 固定 dagre，避免按需初始化 ELK 布局器拖慢首图。
    layout: 'dagre',
    fontFamily: options.fontFamily,
    themeVariables: options.variables,
    // 失败时不把错误图写进页面，交给 React 回退到原始代码。
    suppressErrorRendering: true,
    // 纯 SVG 文本标签更容易跟随主题变量，也避免 foreignObject 的裁剪问题。
    htmlLabels: false,
    logLevel: 'fatal',
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    timeline: { useMaxWidth: true },
  })
}

/** 提取可读错误：Mermaid 的 DetailedError 把正文放在 `str`。 */
function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const detailed = error as { str?: unknown; message?: unknown }
    if (typeof detailed.str === 'string' && detailed.str.trim()) return detailed.str.trim()
    if (typeof detailed.message === 'string' && detailed.message.trim()) return detailed.message.trim()
  }
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'Mermaid 渲染失败'
}

/** 清理 mermaid.render 可能遗留的临时节点（#<id>、#d<id> 与 sandbox iframe #i<id>）。 */
function cleanup(id: string): void {
  for (const nodeId of [id, `d${id}`, `i${id}`]) document.getElementById(nodeId)?.remove()
}

/**
 * 渲染一张 Mermaid 图。
 * @param id 本次渲染的 DOM id（同一页面需唯一）。
 * @param code 图表定义。
 * @param options 主题参数。
 * @returns SVG 字符串。
 */
export async function renderMermaid(id: string, code: string, options: MermaidThemeOptions): Promise<string> {
  return serial(async () => {
    configure(options)
    const parsed = await mermaid.parse(code, { suppressErrors: true })
    if (parsed === false) {
      // 用非抑制模式再解析一次，拿到 mermaid 的具体错误文本（行号、未知图类型等）。
      try { await mermaid.parse(code) }
      catch (error) { throw new Error(describeError(error)) }
      throw new Error('Mermaid 语法无效。')
    }
    try {
      const { svg } = await mermaid.render(id, code)
      return svg
    } catch (error) {
      cleanup(id)
      throw new Error(describeError(error))
    } finally {
      cleanup(id)
    }
  })
}

/**
 * 只校验语法，不写入页面。
 * @param code 图表定义。
 * @param options 主题参数。
 * @returns 是否可渲染。
 */
export async function validateMermaid(code: string, options: MermaidThemeOptions): Promise<boolean> {
  return serial(async () => {
    configure(options)
    return (await mermaid.parse(code, { suppressErrors: true })) !== false
  })
}

const runtime: MermaidRuntime = { renderMermaid, validateMermaid }
export default runtime
