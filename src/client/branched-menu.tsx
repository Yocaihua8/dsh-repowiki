/**
 * React Bits「BranchedMenu」的分支线目录，按 RepoWiki 的页面树做了适配：
 * - 保留原作轨道、曲线分支、选中标记与折叠动画；
 * - 支持递归层级（目录最多三级）与受控 open / active，路由和激活状态仍由 page.tsx 持有；
 * - 行尾可带草稿状态标记，图标复用项目自己的 WikiIcon，不引入额外图标依赖。
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { WikiIcon } from './icons.js'

export type BranchedMenuState = 'ready' | 'writing' | 'pending' | 'failed'

export interface BranchedMenuChild {
  value: string
  label: string
  /** 悬浮提示；页面待生成时带上状态。 */
  title?: string
  /** 1 = 直属子页，2 = 第三级页面。 */
  depth?: number
  icon?: ReactNode
  badge?: ReactNode
  state?: BranchedMenuState
  disabled?: boolean
  expanded?: boolean
  onToggle?: () => void
  toggleLabel?: string
}

export interface BranchedMenuItem {
  /** 顶层节点的页面 id，用于对折叠状态做稳定映射。 */
  id?: string
  label: string
  /** 可打开的页面；纯分组（kind === 'group'）没有 value，只能折叠。 */
  value?: string
  children?: BranchedMenuChild[]
  icon?: ReactNode
  badge?: ReactNode
  state?: BranchedMenuState
  disabled?: boolean
  title?: string
  /** 搜索等强制展开场景下关闭折叠交互。 */
  collapsible?: boolean
}

export interface BranchedMenuProps {
  items: BranchedMenuItem[]
  /** 受控展开项；省略时由组件内部维护。 */
  open?: number[]
  defaultOpen?: number | number[]
  /** 受控选中值。 */
  active?: string
  defaultActive?: string
  onSelect?: (value: string, item: BranchedMenuChild | BranchedMenuItem) => void
  onToggle?: (index: number, open: boolean) => void
  labels?: { expand: string; collapse: string }
  ariaLabel?: string
  color?: string
  accentColor?: string
  lineColor?: string
  width?: number
  rowHeight?: number
  indent?: number
  trunk?: number
  radius?: number
  lineWidth?: number
  fontSize?: number
  drawDuration?: number
  foldDuration?: number
  className?: string
}

const PAD = 6
const MARK = 16
const CHILD_STEP = 14

const toSet = (open: number | number[] | undefined): Set<number> => new Set(open === undefined ? [] : Array.isArray(open) ? open : open >= 0 ? [open] : [])

function firstChildOf(items: BranchedMenuItem[], open: Set<number>): string {
  const first = items.find((item, index) => item.children?.length && open.has(index))
  return first?.children?.[0]?.value ?? ''
}

export function BranchedMenu({
  items,
  open,
  defaultOpen = 0,
  active,
  defaultActive = '',
  onSelect,
  onToggle,
  labels = { expand: 'Expand', collapse: 'Collapse' },
  ariaLabel,
  color = 'var(--dsw-alias-label-primary)',
  accentColor = 'var(--drw-brand)',
  lineColor = 'var(--dsw-alias-border-l2)',
  width = 240,
  rowHeight = 34,
  indent = 30,
  trunk = 10,
  radius = 7,
  lineWidth = 1.2,
  fontSize = 12,
  drawDuration = 400,
  foldDuration = 300,
  className = ''
}: BranchedMenuProps): ReactElement {
  const [innerOpen, setInnerOpen] = useState(() => toSet(defaultOpen))
  const [innerActive, setInnerActive] = useState(() => defaultActive || firstChildOf(items, toSet(defaultOpen)))
  const openSet = useMemo(() => (open === undefined ? innerOpen : new Set(open)), [open, innerOpen])
  const activeValue = active === undefined ? innerActive : active
  const navRef = useRef<HTMLElement>(null)
  const heads = useRef<(HTMLDivElement | null)[]>([])
  const markerRef = useRef<HTMLSpanElement>(null)
  const scrolledFor = useRef('')
  const latest = useRef({ onSelect, onToggle })
  latest.current = { onSelect, onToggle }

  const activeSection = items.findIndex(item => item.value === activeValue || item.children?.some(kid => kid.value === activeValue))
  const markerShown = activeSection >= 0 && (!items[activeSection]?.children || openSet.has(activeSection) || items[activeSection]?.value === activeValue)
  const layoutKey = `${items.map(item => `${item.id ?? item.label}:${item.children?.length ?? 0}`).join('|')}#${[...openSet].sort((a, b) => a - b).join(',')}`

  useLayoutEffect(() => {
    const place = (glide: boolean) => {
      const marker = markerRef.current
      const element = heads.current[activeSection]
      if (!marker) return
      const on = markerShown && element
      if (!glide) marker.style.transition = 'none'
      if (on && element) marker.style.top = `${element.offsetTop + (element.offsetHeight - MARK) / 2}px`
      marker.toggleAttribute('data-on', Boolean(on))
      if (!glide) {
        void marker.offsetHeight
        marker.style.transition = ''
      }
    }
    place(true)
    if (scrolledFor.current !== activeValue) {
      scrolledFor.current = activeValue
      const target = navRef.current?.querySelector<HTMLElement>('.drw-bm__item[data-active]') ?? (activeSection >= 0 ? heads.current[activeSection] : null)
      target?.scrollIntoView?.({ block: 'nearest' })
    }
    let first = true
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      place(false)
    })
    if (navRef.current) observer.observe(navRef.current)
    return () => observer.disconnect()
  }, [activeSection, markerShown, layoutKey, fontSize, rowHeight, activeValue])

  const select = (value: string, item: BranchedMenuChild | BranchedMenuItem) => {
    if (active === undefined) setInnerActive(value)
    latest.current.onSelect?.(value, item)
  }
  const toggle = (index: number) => {
    const isOpen = !openSet.has(index)
    if (open === undefined) {
      setInnerOpen(previous => {
        const next = new Set(previous)
        if (isOpen) next.add(index)
        else next.delete(index)
        return next
      })
    }
    latest.current.onToggle?.(index, isOpen)
  }

  const r = Math.max(0, Math.min(radius, rowHeight / 2 - 2))
  const rowY = (index: number) => PAD + index * rowHeight + rowHeight / 2
  const rowEnd = (kid: BranchedMenuChild) => indent + ((kid.depth ?? 1) - 1) * CHILD_STEP - 8
  const branch = (kid: BranchedMenuChild, index: number) => `M ${trunk} ${rowY(index) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(index)} H ${rowEnd(kid)}`
  const reach = (kid: BranchedMenuChild, index: number) => `M ${trunk} 0 V ${rowY(index) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(index)} H ${rowEnd(kid)}`
  const length = (kid: BranchedMenuChild, index: number) => rowY(index) - r + (Math.PI * r) / 2 + (rowEnd(kid) - trunk - r)

  return (
    <nav
      ref={navRef}
      className={`drw-bm${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
      style={{
        '--bm-w': `${width}px`,
        '--bm-ink': color,
        '--bm-accent': accentColor,
        '--bm-line': lineColor,
        '--bm-font': `${fontSize}px`,
        '--bm-row': `${rowHeight}px`,
        '--bm-indent': `${indent}px`,
        '--bm-line-w': lineWidth,
        '--bm-draw': `${drawDuration}ms`,
        '--bm-fold': `${foldDuration}ms`
      } as CSSProperties}
    >
      <span ref={markerRef} className="drw-bm__marker" aria-hidden="true" />
      {items.map((item, index) => {
        const kids = item.children
        const isOpen = Boolean(kids) && openSet.has(index)
        const sectionActive = item.value === activeValue
        const bodyH = kids?.length ? PAD * 2 + kids.length * rowHeight : 0
        return (
          <div key={item.id ?? item.label} className="drw-bm__section" data-open={isOpen ? '' : undefined}>
            <div ref={element => { heads.current[index] = element }} className="drw-bm__headrow">
              <button
                type="button"
                className="drw-bm__head"
                data-active={sectionActive ? '' : undefined}
                data-state={item.state}
                aria-current={sectionActive ? 'page' : undefined}
                title={item.title ?? item.label}
                disabled={item.disabled}
                aria-expanded={kids && item.collapsible !== false && !item.value ? isOpen : undefined}
                onClick={() => {
                  if (kids && item.collapsible !== false && !item.value) toggle(index)
                  else if (item.value && !item.disabled) select(item.value, item)
                }}
              >
                {item.icon ? <span className="drw-bm__icon" aria-hidden="true">{item.icon}</span> : null}
                <span className="drw-bm__headlabel">{item.label}</span>
                {item.badge ? <span className="drw-bm__badge">{item.badge}</span> : null}
              </button>
              {kids && item.collapsible !== false ? (
                <button
                  type="button"
                  className="drw-bm__toggle"
                  data-open={isOpen ? '' : undefined}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? labels.collapse : labels.expand} ${item.label}`}
                  onClick={() => toggle(index)}
                >
                  <WikiIcon name="chevron-right" size={12} />
                </button>
              ) : null}
            </div>
            {kids ? (
              <div className="drw-bm__body" aria-hidden={isOpen ? undefined : true}>
                <div className="drw-bm__fold">
                  <div className="drw-bm__tree" style={{ height: bodyH }}>
                    <svg className="drw-bm__lines" width={indent} height={bodyH} aria-hidden="true">
                      {kids.length > 0 && <path className="drw-bm__base" d={`M ${trunk} 0 V ${rowY(kids.length - 1) - r}`} />}
                      {kids.map((kid, childIndex) => <path key={kid.value} className="drw-bm__base" d={branch(kid, childIndex)} />)}
                      {kids.map((kid, childIndex) => (
                        <path
                          key={`${kid.value}:reach`}
                          className="drw-bm__reach"
                          d={reach(kid, childIndex)}
                          style={{ strokeDasharray: length(kid, childIndex), strokeDashoffset: kid.value === activeValue ? 0 : length(kid, childIndex) }}
                        />
                      ))}
                    </svg>
                    {kids.map(kid => (
                      <div key={kid.value} className="drw-bm__childrow">
                        <button
                          type="button"
                          className="drw-bm__item"
                          data-active={kid.value === activeValue ? '' : undefined}
                          data-state={kid.state}
                          aria-current={kid.value === activeValue ? 'page' : undefined}
                          title={kid.title ?? kid.label}
                          disabled={kid.disabled}
                          tabIndex={isOpen ? 0 : -1}
                          style={{ paddingLeft: indent + ((kid.depth ?? 1) - 1) * CHILD_STEP }}
                          onClick={() => select(kid.value, kid)}
                        >
                          {kid.icon ? <span className="drw-bm__icon" aria-hidden="true">{kid.icon}</span> : null}
                          <span className="drw-bm__label">{kid.label}</span>
                          {kid.badge ? <span className="drw-bm__badge">{kid.badge}</span> : null}
                        </button>
                        {kid.onToggle && <button type="button" className="drw-bm__toggle drw-bm__toggle-child" data-open={kid.expanded ? '' : undefined} aria-expanded={kid.expanded} aria-label={kid.toggleLabel} tabIndex={isOpen ? 0 : -1} onClick={kid.onToggle}><WikiIcon name="chevron-right" size={12} /></button>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}
