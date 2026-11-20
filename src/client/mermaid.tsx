import { diagramZoom } from '../shared/reading.js'
/**
 * 页面正文的 Mermaid 渲染。
 *
 * - `MermaidMarkdown` 复用共享的围栏识别规则切分 Markdown，逐图渲染；
 * - mermaid 本体放在 `client.mermaid.js` chunk，首次遇到有效图时才下载；
 * - 主题读取宿主 body 上的 DSH 颜色 token，跟随深色/浅色切换重新渲染；
 * - 渲染失败保留原始围栏代码并给出可读提示，不影响同页其他内容。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions, MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { splitMermaidDiagrams } from '../shared/mermaid.js'
import { loadClientChunk } from './chunk-loader.js'
import { MERMAID_THEME_TOKENS, buildMermaidTheme, type MermaidPalette } from './mermaid-theme.js'
import type { MermaidRuntime, MermaidThemeOptions } from './mermaid-types.js'
import { useLocale } from './i18n.js'

type Text = (zh: string, en: string) => string
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
let diagramSequence = 0

function useText(): Text {
  const zh = useLocale().startsWith('zh')
  return (cn, en) => zh ? cn : en
}

/** 缓存运行时 chunk 的加载 Promise；失败后清空以便下次重试。 */
let runtimePromise: Promise<MermaidRuntime> | null = null
function loadRuntime(): Promise<MermaidRuntime> {
  runtimePromise ??= loadClientChunk<MermaidRuntime & { default?: MermaidRuntime }>('./client.mermaid.js').then(loaded => {
    const runtime = loaded.default ?? loaded
    if (!runtime || typeof runtime.renderMermaid !== 'function') throw new Error('Mermaid 运行时 chunk 缺少 renderMermaid 导出。')
    return runtime
  }).catch(error => {
    runtimePromise = null
    throw error
  })
  return runtimePromise
}

interface ThemeSnapshot { signature: string; options: MermaidThemeOptions }
let themeSnapshot: ThemeSnapshot | null = null
const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null
let themeRefreshScheduled = false

/** 宿主 ThemePresenter 用该属性切换深色调色板。 */
function isDark(): boolean {
  if (document.body.hasAttribute('data-ds-dark-theme')) return true
  const scheme = getComputedStyle(document.documentElement).colorScheme.trim()
  if (scheme) return scheme.split(/\s+/).includes('dark') && !scheme.split(/\s+/).includes('light')
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function readTheme(): ThemeSnapshot {
  const style = getComputedStyle(document.body)
  const palette = {} as MermaidPalette
  for (const [key, token, fallback] of MERMAID_THEME_TOKENS) palette[key] = style.getPropertyValue(token).trim() || fallback
  const { signature, options } = buildMermaidTheme(palette, style.fontFamily || 'sans-serif', isDark())
  return { signature, options }
}

function getThemeSnapshot(): ThemeSnapshot {
  themeSnapshot ??= readTheme()
  return themeSnapshot
}

function scheduleThemeRefresh(): void {
  if (themeRefreshScheduled) return
  themeRefreshScheduled = true
  requestAnimationFrame(() => {
    themeRefreshScheduled = false
    const next = readTheme()
    if (next.signature === themeSnapshot?.signature) return
    themeSnapshot = next
    for (const listener of themeListeners) listener()
  })
}

function observeTheme(): void {
  if (themeObserver) return
  themeObserver = new MutationObserver(scheduleThemeRefresh)
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style', 'class'] })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-ds-theme-source'] })
}

function subscribeTheme(listener: () => void): () => void {
  const wasObserving = themeObserver !== null
  themeListeners.add(listener)
  observeTheme()
  // 上一次全部卸载后主题可能已经变化：重新订阅时刷新缓存，交给 React 比对快照。
  if (!wasObserving) {
    const next = readTheme()
    if (next.signature !== themeSnapshot?.signature) themeSnapshot = next
  }
  return () => {
    themeListeners.delete(listener)
    if (!themeListeners.size) { themeObserver?.disconnect(); themeObserver = null }
  }
}

/** 订阅当前主题；签名变化时使用方重新渲染图表。 */
function useMermaidTheme(): ThemeSnapshot {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
}

interface DiagramState { svg: string; error: string; pending: boolean }

function MermaidDiagram({ code, raw, u }: { code: string; raw: string; u: Text }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [scale, setScale] = useState<number | null>(1)
  const figure = useRef<HTMLElement>(null)
  const [previewHeight, setPreviewHeight] = useState(0)
  const openDiagram = () => { setPreviewHeight(figure.current?.getBoundingClientRect().height ?? 0); setScale(1); setExpanded(true) }
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (expanded) { dialog.current?.showModal(); dialog.current?.querySelector<HTMLButtonElement>('button')?.focus() }
    else if (dialog.current?.open) { dialog.current.close(); trigger.current?.focus() }
  }, [expanded])
  const theme = useMermaidTheme()
  const id = useRef(`dsh-repowiki-mermaid-${++diagramSequence}`)
  const [state, setState] = useState<DiagramState>({ svg: '', error: '', pending: true })
  useEffect(() => {
    let active = true
    setState(previous => ({ ...previous, error: '', pending: true }))
    void loadRuntime()
      .then(runtime => runtime.renderMermaid(id.current, code, theme.options))
      .then(svg => { if (active) setState({ svg, error: '', pending: false }) })
      .catch(error => { if (active) setState(previous => ({ ...previous, error: message(error), pending: false })) })
    return () => { active = false }
  }, [code, theme.signature])
  useLayoutEffect(() => {
    if (!expanded) return
    const svg = canvas.current?.querySelector('svg')
    if (!svg) return
    const width = svg.viewBox.baseVal.width || Number.parseFloat(svg.getAttribute('width') ?? '') || 800
    if (scale === null) { svg.style.width = '100%'; svg.style.maxWidth = '100%' }
    else { svg.style.width = `${width * scale}px`; svg.style.maxWidth = 'none' }
    svg.style.height = 'auto'
  }, [expanded, scale, state.svg])
  if (state.error) {
    const detail = state.error.length > 500 ? `${state.error.slice(0, 500)}…` : state.error
    return <section className="drw-mermaid drw-mermaid-failed" role="group" aria-label={u('Mermaid 图渲染失败', 'Mermaid diagram failed')}>
      <p className="drw-mermaid-hint">{u('无法渲染此 Mermaid 图，已保留原始代码。', 'This Mermaid diagram could not be rendered; the original code is kept.')}<span className="drw-mermaid-error">{detail}</span></p>
      <pre className="drw-mermaid-source"><code>{raw.trimEnd()}</code></pre>
    </section>
  }
  if (!state.svg) return <div className="drw-mermaid drw-mermaid-loading" role="status" aria-busy="true">{u('正在渲染 Mermaid 图…', 'Rendering Mermaid diagram…')}</div>
  return <figure ref={figure} style={expanded ? { minHeight: previewHeight } : undefined} className="drw-mermaid" aria-label={u('Mermaid 图', 'Mermaid diagram')} aria-busy={state.pending || undefined}>
    <button type="button" ref={trigger} className="drw-diagram-open" onClick={openDiagram}>{u('放大查看', 'Enlarge diagram')}</button>
    {!expanded && <div className="drw-mermaid-canvas" onClick={openDiagram} dangerouslySetInnerHTML={{ __html: state.svg }} />}
    <dialog ref={dialog} className="drw-diagram-dialog" aria-label={u('查看图表', 'Diagram viewer')} onCancel={e => { e.preventDefault(); setExpanded(false) }} onClose={() => { setExpanded(false); trigger.current?.focus() }}>
      <div className="drw-diagram-toolbar">
        <button type="button" onClick={() => setExpanded(false)}>{u('关闭', 'Close')}</button>
        <button type="button" onClick={() => setScale(null)}>{u('适应窗口', 'Fit window')}</button>
        <button type="button" onClick={() => setScale(1)}>100%</button>
        <button type="button" aria-label={u('缩小', 'Zoom out')} disabled={scale !== null && scale <= 0.5} onClick={() => setScale(v => diagramZoom((v ?? 1) - 0.25))}>−</button>
        <span>{scale === null ? u('适应窗口', 'Fit') : `${Math.round(scale * 100)}%`}</span>
        <button type="button" aria-label={u('放大', 'Zoom in')} disabled={scale !== null && scale >= 2} onClick={() => setScale(v => diagramZoom((v ?? 1) + 0.25))}>+</button>
      </div>
      {expanded && <div className="drw-diagram-viewport"><div ref={canvas} dangerouslySetInnerHTML={{ __html: state.svg }} /></div>}
    </dialog>
  </figure>
}

/**
 * 渲染一段 Wiki Markdown：有效 Mermaid 围栏逐图渲染，其余内容继续走宿主原生 Markdown。
 * @param props 原文、宿主 Markdown 标签与文件引用解析器。
 * @returns 页面正文节点。
 */
export function MermaidMarkdown({ text, labels, fileMentions }: { text: string; labels: MarkdownLabels; fileMentions?: MarkdownFileMentions | undefined }): ReactElement {
  const u = useText()
  const segments = useMemo(() => splitMermaidDiagrams(text), [text])
  const renderLeaf = (segment: { kind: 'markdown'; text: string } | { kind: 'mermaid'; code: string; raw: string }, key: string) =>
    segment.kind === 'markdown'
      ? <MarkdownText key={key} text={segment.text} labels={labels} fileMentions={fileMentions} />
      : <MermaidDiagram key={key} code={segment.code} raw={segment.raw} u={u} />
  return <>{segments.map((segment, index) => segment.kind === 'details'
    ? <details key={`details:${index}`} className="drw-structure-details"><summary>{segment.summary}</summary>{segment.segments.map((child, childIndex) => renderLeaf(child, `details:${index}:${childIndex}`))}</details>
    : renderLeaf(segment, `${segment.kind}:${index}`))}</>
}
