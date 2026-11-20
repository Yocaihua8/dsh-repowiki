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
  /** 行内引用上限（软）：按篇幅动态收紧，上限不超过 25 处。 */
  maxCitations: 25,
  /** 表格行上限（软）：超出说明该改用列表或拆页。 */
  maxTableLines: 20,
  /** 二级标题上限（软）：超出说明该拆页。 */
  maxHeadings: 12,
  /** 首段字符上限（软）：首段用 2-4 句自然语言直接给出结论。 */
  maxLeadChars: 320,
})

const CITATION_SPAN = /`[A-Za-z0-9_./@-]+?(?::\s*L?\d+(?:\s*[-–]\s*L?\d+)?|#L\d+(?:\s*[-–]\s*L?\d+)?)`/g
const CODE_IDENTIFIER = /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g

/** 统计论述段落中的代码符号密度（排除文件行号引用），用于识别「源码复读机」倾向。 */
export function proseCodeDensity(paragraphs: readonly string[]): { proseChars: number; inlineCodeRatio: number; denseParagraphs: number } {
  let proseChars = 0, codeChars = 0, denseParagraphs = 0
  for (const raw of paragraphs) {
    const cleaned = raw.replace(CITATION_SPAN, '').trim()
    if (!cleaned) continue
    proseChars += cleaned.length
    let spanCount = 0
    const withoutSpans = cleaned.replace(/`([^`\n]+)`/g, (_full, inner: string) => {
      codeChars += inner.length
      spanCount++
      return ' '
    })
    const bareIds = (withoutSpans.match(CODE_IDENTIFIER) ?? []).length
    if (spanCount + bareIds >= 6) denseParagraphs++
  }
  return { proseChars, inlineCodeRatio: proseChars > 0 ? codeChars / proseChars : 0, denseParagraphs }
}

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

export function evaluatePage(page: WikiOutlinePage, content: string, sources: SourceExcerpt[], knownPaths: readonly string[], options: { userRoute?: boolean } = {}): PageQuality {
  const citations = parseCitations(content, { paths: knownPaths, allowBare: true }).length
  const fences = count(content, /^```/gm), diagrams = mermaidFenceStats(content), mermaid = diagrams.valid
  const tableLines = content.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line)).length
  const tables = tableLines
  const headings = count(content, /^##\s+\S/gm)
  const sourceCount = unique(sources)
  const hard: string[] = [], soft: string[] = []
  const overview = page.type === 'overview' || page.id === 'overview'
  const isHub = page.isHub === true
  const userFacing = overview || options.userRoute === true || page.type === 'quickstart' || page.type === 'guide' || page.type === 'troubleshooting'
  const minChars = isHub ? 400 : 800
  if (content.trim().length < minChars) hard.push(`正文少于 ${minChars} 字符`)
  if (!/^#\s+\S/m.test(content)) hard.push('缺少一级标题')
  if (headings < (isHub ? 1 : 2)) hard.push(`至少需要 ${isHub ? 1 : 2} 个二级标题`)
  if (citations < 1) hard.push('至少需要 1 个有效行号引用')
  if (sourceCount < (overview || isHub ? 1 : 2)) hard.push(`来源文件不足（至少 ${overview || isHub ? 1 : 2} 个）`)
  if (!isHub && (page.type === 'module' || page.type === 'api')) {
    if (sourceCount < 4) soft.push('来源文件少于 4 个，建议覆盖相关模块文件')
  }
  if (!isHub && (page.type === 'api' || page.type === 'config' || page.type === 'ops' || page.type === 'testing') && !fences && !tableLines)
    soft.push('缺少代码块或表格，建议加入真实调用/配置/命令示例')
  if (diagrams.blocks > mermaid) soft.push(`有 ${diagrams.blocks - mermaid} 个 Mermaid 代码块缺少有效图类型，请使用 flowchart/sequenceDiagram/stateDiagram-v2/classDiagram/erDiagram 等`)
  if (overview && content.length < 1_500) soft.push('总览少于 1,500 字符，建议补充定位、边界与导航')

  // 可读性上限：只做提示，不阻断提交；作者可据实说明并保留。
  const maxChars = isHub ? 3_000 : READABILITY_LIMITS.maxChars
  if (content.length > maxChars)
    soft.push(`正文 ${content.length} 字符超过 ${maxChars}${isHub ? '（导览页应精炼，将细节留给子页）' : `，约 ${Math.round(content.length / 400)} 分钟阅读；建议按小节拆分或精简`}`)
  const citationCap = Math.min(READABILITY_LIMITS.maxCitations, Math.max(8, Math.ceil(content.length / 200)))
  if (citations > citationCap)
    soft.push(`行内引用 ${citations} 处偏多（当前篇幅建议不超过 ${citationCap} 处），请只保留关键结论的句末/段末引用，避免打断阅读`)
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
    soft.push(`首段 ${lead.length} 字符过长，建议先用 2-4 句自然语言直接给出结论，再展开论证`)
  const density = proseCodeDensity(paragraphs)
  if (userFacing && density.proseChars >= 200 && (density.inlineCodeRatio > 0.22 || density.denseParagraphs >= 2))
    soft.push('正文代码符号偏密，总览与使用页请先用自然语言解释行为与效果，将内部实现细节移至技术页')
  else if (!userFacing && density.proseChars >= 300 && density.inlineCodeRatio > 0.40)
    soft.push('正文代码符号占比过高，建议先用自然语言概括意图与机制，再附关键符号锚点')
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
