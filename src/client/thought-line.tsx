import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { WikiIcon } from './icons.js'

export interface ThoughtLineProps {
  label?: string
  doneLabel?: string
  renderLabel?: (text: string, working: boolean) => ReactNode
  glyph?: 'sparkle' | 'dot' | 'none' | ReactNode
  steps?: string[]
  collapsible?: boolean
  collapseOnSettle?: boolean
  color?: string
  glyphColor?: string
  fontSize?: number
  breathPeriod?: number
  breathDepth?: number
  shimmer?: boolean
  shimmerDuration?: number
  settleDuration?: number
  settleBlur?: number
  working?: boolean
  settleAfter?: number
  elapsed?: number
  showTimer?: boolean
  formatTime?: (deciseconds: number) => string
  footer?: ReactNode
  onSettle?: (seconds: number) => void
  className?: string
  style?: CSSProperties
}

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'
const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)'
const GLYPH_DONE = 0.55
const EMPTY_STEPS: string[] = []

const defaultFormat = (ds: number): string =>
  ds < 600 ? `${(ds / 10).toFixed(1)}s` : `${Math.floor(ds / 600)}m ${((ds % 600) / 10).toFixed(1)}s`

const spokenTime = (ds: number): string =>
  ds < 600
    ? `${(ds / 10).toFixed(1)} seconds`
    : `${Math.floor(ds / 600)} minutes ${((ds % 600) / 10).toFixed(1)} seconds`

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

function animateElement(
  el: HTMLElement | null,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (!el || typeof el.animate !== 'function') return null
  try {
    return el.animate(keyframes, options)
  } catch {
    return null
  }
}

/**
 * React Bits「ThoughtLine」思维与任务轨迹行（零外部依赖实现）。
 * - 复用 WikiIcon 图标，支持运行态呼吸 + shimmer 扫光、受控/自计时时长滑移、
 *   完成后平滑收敛折叠，以及通过 `footer` 在折叠体内附带元信息。
 */
export function ThoughtLine({
  label = 'Thinking…',
  doneLabel = '',
  renderLabel,
  glyph = 'sparkle',
  steps = EMPTY_STEPS,
  collapsible = true,
  collapseOnSettle = true,
  color = '',
  glyphColor = '',
  fontSize = 14,
  breathPeriod = 1.6,
  breathDepth = 0.45,
  shimmer = true,
  shimmerDuration = 1.8,
  settleDuration = 350,
  settleBlur = 2,
  working = true,
  settleAfter = 0,
  elapsed,
  showTimer = true,
  formatTime,
  footer,
  onSettle,
  className = '',
  style,
}: ThoughtLineProps): ReactElement {
  const reduce = useReducedMotionPreference()
  const [autoSettled, setAutoSettled] = useState(false)
  const isWorking = working && !autoSettled
  const [open, setOpen] = useState(() => (isWorking ? true : !collapseOnSettle))
  const doneText = doneLabel || (showTimer ? 'Thought for' : 'Done thinking')
  const hasFooter = footer !== undefined && footer !== null && footer !== false
  const hasTrace = steps.length > 0 || hasFooter
  const depth = reduce ? Math.min(breathDepth, 0.2) : breathDepth
  const period = reduce ? breathPeriod * 1.5 : breathPeriod
  const trough = 1 - depth
  const sheen = shimmer && !reduce
  const format = formatTime ?? defaultFormat
  const formatRef = useRef(format)
  formatRef.current = format

  const glyphRef = useRef<HTMLSpanElement>(null)
  const breathRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<HTMLSpanElement>(null)
  const stackRef = useRef<HTMLSpanElement>(null)
  const workRef = useRef<HTMLSpanElement>(null)
  const doneRef = useRef<HTMLSpanElement>(null)
  const initialDs = elapsed != null ? Math.max(0, Math.round(elapsed * 10)) : 0
  const dsRef = useRef(initialDs)
  if (elapsed != null) dsRef.current = initialDs
  const prevGlideWorking = useRef(isWorking)
  const prevTransitionWorking = useRef(isWorking)
  const latest = useRef({ onSettle })
  latest.current = { onSettle }
  const [announce, setAnnounce] = useState(() =>
    isWorking ? label : showTimer ? `${doneText} ${spokenTime(initialDs)}` : doneText,
  )

  useEffect(() => {
    if (working) setAutoSettled(false)
  }, [working])

  useEffect(() => {
    const glyphEl = glyphRef.current
    const breathEl = breathRef.current
    if (!breathEl) return undefined
    let cancelled = false
    const running: Animation[] = []
    const push = (anim: Animation | null) => {
      if (anim) running.push(anim)
      return anim
    }
    const loop = (el: HTMLElement, delayMs: number) =>
      push(
        animateElement(
          el,
          [{ opacity: trough }, { opacity: 1 }, { opacity: trough }],
          { duration: Math.max(100, period * 1000), easing: EASE_IN_OUT, iterations: Infinity, delay: delayMs },
        ),
      )

    if (isWorking) {
      if (depth > 0) {
        if (sheen) push(animateElement(breathEl, [{ opacity: 1 }], { duration: 200, easing: EASE_OUT, fill: 'forwards' }))
        if (glyphEl) {
          const lead = push(animateElement(glyphEl, [{ opacity: trough }], { duration: 200, easing: EASE_OUT, fill: 'forwards' }))
          const startLoops = () => {
            if (cancelled) return
            loop(glyphEl, 0)
            if (!sheen) loop(breathEl, 140)
          }
          if (lead?.finished) void lead.finished.then(startLoops, () => {})
          else startLoops()
        } else if (!sheen) {
          loop(breathEl, 140)
        }
      } else {
        push(animateElement(glyphEl, [{ opacity: 1 }], { duration: 200, easing: EASE_OUT, fill: 'forwards' }))
        push(animateElement(breathEl, [{ opacity: 1 }], { duration: 200, easing: EASE_OUT, fill: 'forwards' }))
      }
    } else {
      push(animateElement(glyphEl, [{ opacity: GLYPH_DONE }], { duration: settleDuration, easing: EASE_OUT, fill: 'forwards' }))
      push(animateElement(breathEl, [{ opacity: 1 }], { duration: settleDuration, easing: EASE_OUT, fill: 'forwards' }))
    }

    return () => {
      cancelled = true
      for (const anim of running) {
        try { anim.cancel() } catch { /* Ignore already-cancelled animations. */ }
      }
    }
  }, [isWorking, period, depth, trough, settleDuration, glyph, sheen])

  const paint = (ds: number) => {
    dsRef.current = ds
    if (timerRef.current) timerRef.current.textContent = formatRef.current(ds)
  }

  useLayoutEffect(() => {
    if (elapsed != null) {
      paint(Math.max(0, Math.round(elapsed * 10)))
      return undefined
    }
    if (!isWorking) return undefined
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    paint(0)
    const id = window.setInterval(() => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const ds = Math.floor((now - startedAt) / 100)
      paint(ds)
      if (settleAfter > 0 && ds >= Math.round(settleAfter * 10)) setAutoSettled(true)
    }, 100)
    return () => window.clearInterval(id)
  }, [isWorking, elapsed, settleAfter])

  useLayoutEffect(() => {
    const timer = timerRef.current
    const stack = stackRef.current
    if (!timer || !stack) return undefined
    const place = (glide: boolean) => {
      const active = isWorking ? workRef.current : doneRef.current
      if (!active) return
      const shift = active.offsetWidth - stack.offsetWidth
      if (!glide) timer.style.transition = 'none'
      timer.style.transform = `translateX(${shift}px)`
      if (!glide) {
        void timer.offsetWidth
        timer.style.transition = ''
      }
    }
    place(prevGlideWorking.current !== isWorking)
    prevGlideWorking.current = isWorking
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => place(false))
    if (workRef.current) observer.observe(workRef.current)
    if (doneRef.current) observer.observe(doneRef.current)
    return () => observer.disconnect()
  }, [isWorking, label, doneText, fontSize, showTimer, elapsed])

  useEffect(() => {
    const wasWorking = prevTransitionWorking.current
    prevTransitionWorking.current = isWorking
    if (wasWorking === isWorking) {
      if (isWorking) setAnnounce(label)
      return
    }
    if (isWorking) {
      setOpen(true)
      setAnnounce(label)
      return
    }
    if (collapseOnSettle) setOpen(false)
    setAnnounce(showTimer ? `${doneText} ${spokenTime(dsRef.current)}` : doneText)
    latest.current.onSettle?.(dsRef.current / 10)
  }, [isWorking, collapseOnSettle, label, doneText, showTimer])

  const toggle = hasTrace && collapsible
  const head = (
    <>
      {glyph !== 'none' ? (
        <span ref={glyphRef} className="drw-tl__glyph" aria-hidden="true">
          {glyph === 'sparkle' ? (
            <WikiIcon name="sparkle" size={Math.max(12, Math.round(fontSize * 1.1))} />
          ) : glyph === 'dot' ? (
            <span className="drw-tl__dot" />
          ) : (
            glyph
          )}
        </span>
      ) : null}
      <span ref={stackRef} className="drw-tl__label" aria-hidden="true">
        <span ref={workRef} className="drw-tl__text" data-active={isWorking ? '' : undefined}>
          <span ref={breathRef} className="drw-tl__breath" data-shimmer={sheen ? '' : undefined}>
            {renderLabel ? renderLabel(label, true) : label}
          </span>
        </span>
        <span
          ref={doneRef}
          className="drw-tl__text drw-tl__text--done"
          data-active={isWorking ? undefined : ''}
        >
          {renderLabel ? renderLabel(doneText, false) : doneText}
        </span>
      </span>
      {showTimer ? (
        <span ref={timerRef} className="drw-tl__timer" data-done={isWorking ? undefined : ''} aria-hidden="true">
          {format(dsRef.current)}
        </span>
      ) : null}
      {collapsible ? (
        <span className="drw-tl__chevron" data-on={hasTrace ? '' : undefined} aria-hidden="true">
          <WikiIcon name="chevron-down" size={Math.max(12, Math.round(fontSize * 0.9))} />
        </span>
      ) : null}
      <span className="drw-tl__sr" role="status">
        {announce}
      </span>
    </>
  )

  return (
    <div
      className={`drw-tl${className ? ` ${className}` : ''}`}
      data-working={isWorking ? '' : undefined}
      data-open={open && hasTrace ? '' : undefined}
      style={{
        '--tl-font': `${fontSize}px`,
        ...(color ? { '--tl-color': color } : {}),
        ...(glyphColor || color ? { '--tl-glyph': glyphColor || color } : {}),
        '--tl-settle': `${settleDuration}ms`,
        '--tl-blur': `${settleBlur}px`,
        '--tl-shimmer': `${shimmerDuration}s`,
        ...style,
      } as CSSProperties}
    >
      {collapsible ? (
        <button
          type="button"
          className="drw-tl__head"
          data-toggle={toggle ? '' : undefined}
          aria-expanded={toggle ? open : undefined}
          tabIndex={toggle ? 0 : -1}
          onClick={() => {
            if (toggle) setOpen(value => !value)
          }}
        >
          {head}
        </button>
      ) : (
        <div className="drw-tl__head">{head}</div>
      )}
      {hasTrace ? (
        <div className="drw-tl__trace" data-open={open ? '' : undefined} aria-hidden={!open}>
          <div className="drw-tl__fold">
            <div className="drw-tl__panel" data-split={steps.length > 0 && hasFooter ? '' : undefined}>
              {steps.length > 0 && (
                <div className="drw-tl__steps">
                  {steps.map((text, index) => {
                    const done = !isWorking || index < steps.length - 1
                    return (
                      <div key={`${index}-${text}`} className="drw-tl__step" data-done={done ? '' : undefined}>
                        <span className="drw-tl__mark" aria-hidden="true">
                          {done ? (
                            <WikiIcon name="check" size={Math.max(12, Math.round(fontSize * 0.85))} />
                          ) : (
                            <i className="drw-tl__pulse" />
                          )}
                        </span>
                        <span className="drw-tl__step-text">{text}</span>
                      </div>
                    )
                  })}
                </div>
              )}
              {hasFooter ? <div className="drw-tl__footer">{footer}</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default ThoughtLine
