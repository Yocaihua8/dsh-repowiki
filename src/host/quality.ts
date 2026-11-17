import type { PageQualityMeta, QualityReport, SourceExcerpt } from '../shared/types.js'
import { mermaidFenceStats } from '../shared/mermaid.js'
import type { WikiOutlinePage } from './prompts.js'
import { parseCitations } from './citations.js'

export type PageQuality = PageQualityMeta

/** 落盘用的紧凑质量结果；完整警告仍保留在任务状态/日志中。 */
export function compactQuality(quality: PageQuality): PageQualityMeta {
  const compact = (items: string[]): string[] => items.slice(0, 8).map(item => item.slice(0, 500))
  return { ...quality, hard: compact(quality.hard), soft: compact(quality.soft) }
}

const count = (content: string, pattern: RegExp) => (content.match(pattern) ?? []).length
const unique = (sources: SourceExcerpt[]) => new Set(sources.map(source => source.path)).size
/** 可读性上限：门禁同时在「太短」和「太长/太密」两侧生效。 */
export const READABILITY_LIMITS = Object.freeze({
  /** 单页正文字符上限（软），约 20 分钟阅读。 */
  maxChars: 8_000,
  /** 单段字符上限（软）：超出后应拆段或加小标题。 */
  maxParagraphChars: 400,
  /** 单段字符硬上限：再长就无法作为论述段落阅读。 */
  maxParagraphHard: 2_000,
  /** 行内引用上限（软）：超出说明正文被行号切碎。 */
  maxCitations: 40,
  /** 表格行上限（软）：超出说明该改用列表或拆页。 */
  maxTableLines: 20,
  /** 二级标题上限（软）：超出说明该拆页。 */
  maxHeadings: 12,
  /** 首段字符上限（软）：首段应给出结论而非铺垫。 */
  maxLeadChars: 200,
})

/** 抽出参与阅读的正文段落：跳过标题、代码围栏、表格与列表，只看论述段落。 */
export function proseParagraphs(content: string): string[] {
  const paragraphs: string[] = []
  let inFence = false
  for (const block of content.split(/\n{2,}/)) {
    const lines = block.split('\n').filter(line => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return false }
      return !inFence
    })
    const text = lines.join('\n').trim()
    if (!text) continue
    if (/^#{1,6}\s/.test(text) || text.startsWith('|') || /^[-*+]\s/.test(text) || /^\d+\.\s/.test(text) || text.startsWith('>')) continue
    paragraphs.push(text)
  }
  return paragraphs
}

export function evaluatePage(page: WikiOutlinePage, content: string, sources: SourceExcerpt[], knownPaths: readonly string[]): PageQuality {
  const citations = parseCitations(content, { paths: knownPaths, allowBare: true }).length
  const fences = count(content, /^```/gm), diagrams = mermaidFenceStats(content), mermaid = diagrams.valid
  const tableLines = content.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line)).length
  const tables = tableLines
  const headings = count(content, /^##\s+\S/gm)
  const sourceCount = unique(sources)
  const hard: string[] = [], soft: string[] = []
  if (content.trim().length < 800) hard.push('正文少于 800 字符')
  if (!/^#\s+\S/m.test(content)) hard.push('缺少一级标题')
  if (headings < 2) hard.push('至少需要 2 个二级标题')
  if (citations < 1) hard.push('至少需要 1 个有效行号引用')
  const overview = page.type === 'overview' || page.id === 'overview'
  if (sourceCount < (overview ? 1 : 2)) hard.push(`来源文件不足（至少 ${overview ? 1 : 2} 个）`)
  if (page.type === 'module' || page.type === 'api') {
    if (sourceCount < 4) soft.push('来源文件少于 4 个，建议覆盖相关模块文件')
  }
  if ((page.type === 'api' || page.type === 'config' || page.type === 'ops' || page.type === 'testing') && !fences && !tableLines)
    soft.push('缺少代码块或表格，建议加入真实调用/配置/命令示例')
  if (diagrams.blocks > mermaid) soft.push(`有 ${diagrams.blocks - mermaid} 个 Mermaid 代码块缺少有效图类型，请使用 flowchart/sequenceDiagram/stateDiagram-v2/classDiagram/erDiagram 等`)
  if (overview && content.length < 1_500) soft.push('总览少于 1,500 字符，建议补充定位、边界与导航')

  // 可读性上限：只做提示，不阻断提交；作者可据实说明并保留。
  if (content.length > READABILITY_LIMITS.maxChars)
    soft.push(`正文 ${content.length} 字符超过 ${READABILITY_LIMITS.maxChars}，约 ${Math.round(content.length / 400)} 分钟阅读；建议按小节拆分或精简`)
  if (citations > READABILITY_LIMITS.maxCitations)
    soft.push(`行内引用 ${citations} 处偏多，建议正文只保留关键结论的引用，其余收进页尾“源码依据”`)
  if (tableLines > READABILITY_LIMITS.maxTableLines)
    soft.push(`表格占 ${tableLines} 行偏多，建议只保留多项对照，保留必要对照`)
  if (headings > READABILITY_LIMITS.maxHeadings)
    soft.push(`二级标题 ${headings} 个偏多，建议拆分为多页`)
  const paragraphs = proseParagraphs(content)
  const longParagraphs = paragraphs.filter(paragraph => paragraph.length > READABILITY_LIMITS.maxParagraphChars)
  if (longParagraphs.length)
    soft.push(`有 ${longParagraphs.length} 个段落超过 ${READABILITY_LIMITS.maxParagraphChars} 字符，建议拆段或加小标题`)
  const oversized = paragraphs.find(paragraph => paragraph.length > READABILITY_LIMITS.maxParagraphHard)
  if (oversized) hard.push(`存在超过 ${READABILITY_LIMITS.maxParagraphHard} 字符的段落，无法作为论述段落阅读，请拆分`)
  const lead = paragraphs[0]
  if (lead && lead.length > READABILITY_LIMITS.maxLeadChars)
    soft.push(`首段 ${lead.length} 字符过长，建议先用 3-5 行给出结论，再展开论证`)
  return { chars: content.length, lines: content.split('\n').length, citations, sources: sourceCount, fences, tables, mermaid, hard, soft }
}

export function aggregateQuality(pages: Array<{ content: string; sources: SourceExcerpt[]; quality: PageQuality }>, verified: number, warnings: string[]): QualityReport {
  const sources = new Set(pages.flatMap(page => page.sources.map(source => source.path)))
  return {
    pages: pages.length,
    chars: pages.reduce((n, page) => n + page.quality.chars, 0),
    lines: pages.reduce((n, page) => n + page.quality.lines, 0),
    sources: sources.size,
    citations: pages.reduce((n, page) => n + page.quality.citations, 0),
    fences: pages.reduce((n, page) => n + page.quality.fences, 0),
    tables: pages.reduce((n, page) => n + page.quality.tables, 0),
    mermaid: pages.reduce((n, page) => n + page.quality.mermaid, 0),
    verified,
    warnings,
  }
}
