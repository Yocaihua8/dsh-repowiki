/**
 * Mermaid 围栏的共享识别规则。
 *
 * Host 质量门禁与客户端渲染入口都从这里取判定结果，避免出现“质量检查认为
 * 图有效、页面却按普通代码块展示”或反向的不一致。规则沿用 0.7.5 的
 * `src/host/quality.ts`：
 *
 * - 围栏：行首 ```mermaid（可带 info string，大小写不敏感），闭合 ``` 必须在行首；
 * - 有效图类型：跳过空行和 `%%` 注释/指令行后，取前 12 行，首行匹配受支持的图类型。
 */

/** 一处 Mermaid 围栏在原文中的位置与内容。 */
export interface MermaidFence {
  /** 围栏起始偏移（包含开头 ```）。 */
  start: number
  /** 围栏结束偏移（紧跟闭合 ```，不含其后的换行）。 */
  end: number
  /** 围栏内的图表定义，原样保留。 */
  code: string
  /** 完整围栏原文，渲染失败时用于回退展示。 */
  raw: string
}

/** 文档切分后的片段：普通 Markdown、一张 Mermaid 图，或包含 Mermaid 图的折叠块。 */
export type MermaidSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'mermaid'; code: string; raw: string }
  | { kind: 'details'; summary: string; segments: Array<{ kind: 'markdown'; text: string } | { kind: 'mermaid'; code: string; raw: string }> }

/**
 * 受支持的 Mermaid 图类型。与 Mermaid 的图类型指令一致，未知类型不进入渲染。
 * `stateDiagram-v2` 由 `stateDiagram(?:-v2)?` 覆盖。
 */
const DIAGRAM_TYPE = /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|gitGraph|sankey-beta|xychart-beta|block-beta)\b/m

/** 每次调用新建正则，避免共享 `lastIndex` 影响 `matchAll` 结果。 */
const fencePattern = () => /^```mermaid[^\n]*\r?\n([\s\S]*?)^```/gmi

/**
 * 找出全部 Mermaid 围栏（包括类型无效的块）。
 * @param content Markdown 原文。
 * @returns 按出现顺序排列的围栏，带原文偏移用于切分。
 */
export function findMermaidFences(content: string): MermaidFence[] {
  const fences: MermaidFence[] = []
  for (const match of content.matchAll(fencePattern())) {
    const start = match.index ?? 0
    fences.push({ start, end: start + match[0].length, code: match[1] ?? '', raw: match[0] })
  }
  return fences
}

/**
 * 判断一段 Mermaid 代码是否声明了受支持的图类型。
 * 只检查图表定义头部，不做完整语法解析；完整语法由渲染器在浏览器端校验。
 * @param code 围栏内的图表定义。
 * @returns 首个有效行是否匹配受支持的图类型。
 */
export function hasMermaidDiagramType(code: string): boolean {
  const head = code.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('%%')).slice(0, 12).join('\n')
  return DIAGRAM_TYPE.test(head)
}

/**
 * 统计页面中的 Mermaid 围栏与有效图数量，供质量门禁使用。
 * @param content Markdown 原文。
 * @returns 围栏总数与通过类型判定的数量。
 */
export function mermaidFenceStats(content: string): { blocks: number; valid: number } {
  const fences = findMermaidFences(content)
  return { blocks: fences.length, valid: fences.filter(fence => hasMermaidDiagramType(fence.code)).length }
}

function splitFlatMermaidDiagrams(content: string): Array<{ kind: 'markdown'; text: string } | { kind: 'mermaid'; code: string; raw: string }> {
  const segments: Array<{ kind: 'markdown'; text: string } | { kind: 'mermaid'; code: string; raw: string }> = []
  let cursor = 0
  for (const fence of findMermaidFences(content)) {
    if (!hasMermaidDiagramType(fence.code)) continue
    if (fence.start > cursor) segments.push({ kind: 'markdown', text: content.slice(cursor, fence.start) })
    segments.push({ kind: 'mermaid', code: fence.code, raw: fence.raw })
    cursor = fence.end
  }
  if (cursor < content.length) segments.push({ kind: 'markdown', text: content.slice(cursor) })
  return segments.length ? segments : [{ kind: 'markdown', text: content }]
}

/**
 * 按有效 Mermaid 图切分 Markdown，供页面逐图渲染。
 * 类型无效的围栏留在 Markdown 片段中，继续按原始代码块展示，不尝试渲染。
 * 包含有效 Mermaid 图的 `<details>` 折叠块会保持整体结构，避免被切碎。
 * 没有有效图时返回单个 Markdown 片段。
 * @param content Markdown 原文。
 * @returns Markdown、图表与折叠片段，顺序与原文一致。
 */
export function splitMermaidDiagrams(content: string): MermaidSegment[] {
  const detailsPattern = /^<details>\r?\n<summary>([^\n<]+)<\/summary>\r?\n([\s\S]*?)^<\/details>/gm
  const blocks = [...content.matchAll(detailsPattern)].filter(match => mermaidFenceStats(match[2] ?? '').valid > 0)
  if (!blocks.length) return splitFlatMermaidDiagrams(content)
  const segments: MermaidSegment[] = []
  let cursor = 0
  for (const match of blocks) {
    const start = match.index ?? 0
    if (start > cursor) segments.push(...splitFlatMermaidDiagrams(content.slice(cursor, start)))
    segments.push({ kind: 'details', summary: (match[1] ?? '').trim(), segments: splitFlatMermaidDiagrams((match[2] ?? '').trim()) })
    cursor = start + match[0].length
  }
  if (cursor < content.length) segments.push(...splitFlatMermaidDiagrams(content.slice(cursor)))
  return segments.length ? segments : [{ kind: 'markdown', text: content }]
}
