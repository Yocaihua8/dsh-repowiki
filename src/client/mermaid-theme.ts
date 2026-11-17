/**
 * Mermaid 主题：把 DSH 的语义颜色 token 映射为 Mermaid base 主题变量。
 *
 * 页面主题由宿主 ThemePresenter 写在 `body[data-ds-dark-theme]` 与 body 内联
 * CSS 变量上，因此这里只消费 token 名，不复制宿主的调色板。纯函数便于测试；
 * 读取 DOM 的部分在 `mermaid.tsx`。
 */
import type { MermaidThemeOptions } from './mermaid-types.js'

/** 渲染 Mermaid 时需要的语义颜色。 */
export interface MermaidPalette {
  /** 应用底色，用于 SVG 画布与簇背景。 */
  background: string
  /** 一级抬升表面，用于图注/边标签底色。 */
  layer1: string
  /** 节点与卡片表面。 */
  layer2: string
  /** 弱边框。 */
  border1: string
  /** 强边框与连线。 */
  border2: string
  /** 品牌色，用作节点描边与激活线。 */
  brand: string
  /** 主文本。 */
  text: string
  /** 次要文本，用作连线颜色。 */
  secondaryText: string
  /** 错误状态色，用于今日线等强调。 */
  error: string
  /** 警告状态色，用于图注边框。 */
  warn: string
}

/** 宿主 token 名与缺少样式时的回退值。 */
export const MERMAID_THEME_TOKENS = [
  ['background', '--dsw-alias-bg-base', '#ffffff'],
  ['layer1', '--dsw-alias-bg-layer-1', '#f7f7f8'],
  ['layer2', '--dsw-alias-bg-layer-2', '#ececf0'],
  ['border1', '--dsw-alias-border-l1', '#e4e4e8'],
  ['border2', '--dsw-alias-border-l2', '#cfcfd6'],
  ['brand', '--dsw-alias-brand-primary', '#4d6bfe'],
  ['text', '--dsw-alias-label-primary', '#1a1a1c'],
  ['secondaryText', '--dsw-alias-label-secondary', '#5b5b66'],
  ['error', '--dsw-alias-state-error-primary', '#d92d20'],
  ['warn', '--dsw-alias-state-warn-primary', '#cc8330'],
] as const satisfies ReadonlyArray<readonly [keyof MermaidPalette, string, string]>

/**
 * 把语义颜色转换为 Mermaid 图变量，覆盖流程图、时序图、状态图、类图和 ER 图的常用键。
 * @param palette 从宿主 token 读取的颜色。
 * @param fontFamily 页面的内容字体。
 * @param dark 当前是否为深色主题。
 * @returns 传给 `mermaid.initialize` 的完整渲染参数与稳定签名。
 */
export function buildMermaidTheme(palette: MermaidPalette, fontFamily: string, dark: boolean): { signature: string; options: MermaidThemeOptions } {
  const variables: Record<string, string | boolean> = {
    darkMode: dark,
    background: palette.layer1,
    fontFamily,
    primaryColor: palette.layer2,
    primaryTextColor: palette.text,
    primaryBorderColor: palette.brand,
    secondaryColor: palette.layer2,
    secondaryTextColor: palette.text,
    secondaryBorderColor: palette.border2,
    tertiaryColor: palette.layer1,
    tertiaryTextColor: palette.text,
    tertiaryBorderColor: palette.border1,
    mainBkg: palette.layer2,
    nodeBkg: palette.layer2,
    nodeBorder: palette.brand,
    nodeTextColor: palette.text,
    clusterBkg: palette.background,
    clusterBorder: palette.border1,
    defaultLinkColor: palette.secondaryText,
    lineColor: palette.border2,
    arrowheadColor: palette.border2,
    textColor: palette.text,
    titleColor: palette.text,
    edgeLabelBackground: palette.layer1,
    labelTextColor: palette.text,
    labelBoxBkgColor: palette.layer1,
    labelBoxBorderColor: palette.border2,
    // sequenceDiagram
    actorBkg: palette.layer2,
    actorBorder: palette.brand,
    actorTextColor: palette.text,
    actorLineColor: palette.border2,
    signalColor: palette.secondaryText,
    signalTextColor: palette.text,
    activationBkgColor: palette.layer2,
    activationBorderColor: palette.brand,
    sequenceNumberColor: palette.layer1,
    loopTextColor: palette.text,
    noteBkgColor: palette.layer2,
    noteTextColor: palette.text,
    noteBorderColor: palette.warn,
    // stateDiagram-v2 / classDiagram
    labelColor: palette.text,
    altBackground: palette.layer2,
    classText: palette.text,
    // erDiagram
    attributeBackgroundColorOdd: palette.layer1,
    attributeBackgroundColorEven: palette.layer2,
    // gantt / timeline / pie 的基础可读性
    sectionBkgColor: palette.layer1,
    sectionBkgColor2: palette.layer2,
    altSectionBkgColor: palette.layer2,
    taskBkgColor: palette.brand,
    taskTextColor: palette.layer1,
    taskBorderColor: palette.brand,
    gridColor: palette.border1,
    todayLineColor: palette.error,
    pieTitleTextColor: palette.text,
    pieLegendTextColor: palette.text,
    pieStrokeColor: palette.background,
    pieOuterStrokeColor: palette.border1,
  }
  const options: MermaidThemeOptions = { dark, fontFamily, variables }
  return { signature: themeSignature(options), options }
}

/**
 * 生成主题签名，供 React 判断是否需要重新渲染图表。
 * @param options 渲染参数。
 * @returns 稳定字符串。
 */
export function themeSignature(options: MermaidThemeOptions): string {
  return JSON.stringify([options.dark, options.fontFamily, options.variables])
}
