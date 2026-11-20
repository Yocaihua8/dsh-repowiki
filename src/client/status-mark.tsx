import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'

export type StatusMarkStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface StatusMarkProps {
  status?: StatusMarkStatus
  progress?: number
  label?: ReactNode
  color?: string
  doneColor?: string
  errorColor?: string
  size?: number
  strokeWidth?: number
  dashes?: number
  fontSize?: number
  spinDuration?: number
  arcLength?: number
  drawDuration?: number
  fillOpacity?: number
  strike?: boolean
  strikeDelay?: number
  labels?: Partial<Record<StatusMarkStatus, string>>
  className?: string
  style?: CSSProperties
}

const CHECK = 'M7.5 12.25 10.5 15.25 16.75 8.75'
const CROSS = 'M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5'
const IDLE_DASH = 0.3
const MORPH_MS = 300
const UI_MS = 300
const MORPH_CURVE = [0.77, 0, 0.175, 1] as const
const UI_CURVE = [0.23, 1, 0.32, 1] as const

const DEFAULT_TEXT: Record<StatusMarkStatus, string> = {
  pending: 'Pending',
  running: 'In progress',
  done: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

function cubicBezierAt(p1x: number, p1y: number, p2x: number, p2y: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const sampleX = (t: number) => ((1 - 3 * p2x + 3 * p1x) * t + (3 * p2x - 6 * p1x)) * t * t + 3 * p1x * t
  const sampleY = (t: number) => ((1 - 3 * p2y + 3 * p1y) * t + (3 * p2y - 6 * p1y)) * t * t + 3 * p1y * t
  let lo = 0
  let hi = 1
  let t = x
  for (let i = 0; i < 12; i++) {
    const est = sampleX(t)
    if (Math.abs(est - x) < 1e-4) break
    if (est < x) lo = t
    else hi = t
    t = 0.5 * (lo + hi)
  }
  return sampleY(t)
}

interface ScalarTrack {
  get: () => number
  jump: (next: number) => void
  tween: (to: number, durationMs: number, curve: readonly [number, number, number, number]) => Promise<boolean>
  spin: (velocityPerMs: number) => void
  onChange: (listener: (value: number) => void) => () => void
  stop: () => void
}

function createScalarTrack(initial: number): ScalarTrack {
  let current = initial
  let rafId = 0
  let resolvePending: ((completed: boolean) => void) | null = null
  const listeners = new Set<(value: number) => void>()

  const notify = (next: number) => {
    current = next
    for (const listener of listeners) listener(next)
  }

  const cancelActive = (completed: boolean) => {
    if (rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId)
    }
    rafId = 0
    if (resolvePending) {
      const done = resolvePending
      resolvePending = null
      done(completed)
    }
  }

  return {
    get: () => current,
    jump: next => {
      cancelActive(false)
      notify(next)
    },
    tween: (to, durationMs, curve) => {
      cancelActive(false)
      if (typeof requestAnimationFrame !== 'function' || durationMs <= 0 || Math.abs(to - current) < 1e-6) {
        notify(to)
        return Promise.resolve(true)
      }
      const from = current
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      return new Promise<boolean>(resolve => {
        resolvePending = resolve
        const frame = (now: number) => {
          const progress = clamp01((now - startedAt) / durationMs)
          const eased = cubicBezierAt(curve[0], curve[1], curve[2], curve[3], progress)
          notify(from + (to - from) * eased)
          if (progress >= 1) {
            rafId = 0
            resolvePending = null
            resolve(true)
            return
          }
          rafId = requestAnimationFrame(frame)
        }
        rafId = requestAnimationFrame(frame)
      })
    },
    spin: velocityPerMs => {
      cancelActive(false)
      if (typeof requestAnimationFrame !== 'function') return
      let last = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const frame = (now: number) => {
        const dt = Math.max(0, now - last)
        last = now
        notify(current + velocityPerMs * dt)
        rafId = requestAnimationFrame(frame)
      }
      rafId = requestAnimationFrame(frame)
    },
    onChange: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    stop: () => cancelActive(false),
  }
}

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

/**
 * React Bits「StatusMark」原位形变状态徽标（零外部动画依赖实现）。
 * - 虚线环（pending/cancelled）↔ 进度弧（running）↔ 实心环 + 路径描边（done/failed）；
 * - 几何与动效曲线还原原组件，类名统一前缀为 `.drw-sm`。
 */
export function StatusMark({
  status = 'pending',
  progress,
  label,
  color = 'currentColor',
  doneColor = 'var(--dsw-alias-state-success-primary, #22c55e)',
  errorColor = 'var(--dsw-alias-state-error-primary, #ef4444)',
  size = 20,
  strokeWidth = 2,
  dashes = 8,
  fontSize = 14,
  spinDuration = 1100,
  arcLength = 0.68,
  drawDuration = 240,
  fillOpacity = 0.06,
  strike = true,
  strikeDelay = 60,
  labels,
  className = '',
  style,
}: StatusMarkProps): ReactElement {
  const reduce = useReducedMotionPreference()
  const r = 10 - strokeWidth / 2
  const C = 2 * Math.PI * r
  const P = C / Math.max(1, dashes)
  const determinate = status === 'running' && typeof progress === 'number' && Number.isFinite(progress)
  const indeterminate = status === 'running' && !determinate
  const solid = status === 'running' || status === 'done' || status === 'failed'
  const targetArc = indeterminate ? arcLength : determinate ? clamp01(progress) : 1

  const modeTrack = useRef<ScalarTrack | null>(null)
  const arcTrack = useRef<ScalarTrack | null>(null)
  const travelTrack = useRef<ScalarTrack | null>(null)
  modeTrack.current ??= createScalarTrack(solid ? 1 : 0)
  arcTrack.current ??= createScalarTrack(targetArc)
  travelTrack.current ??= createScalarTrack(0)

  const ringRef = useRef<SVGCircleElement>(null)
  const geo = useRef({ C, P })
  geo.current = { C, P }
  const gen = useRef(0)

  const initialDash = useRef<string | null>(null)
  if (initialDash.current === null) {
    const m0 = solid ? 1 : 0
    const dash = IDLE_DASH * P + (targetArc * C - IDLE_DASH * P) * m0
    const gap = (1 - IDLE_DASH) * P + ((1 - targetArc) * C - (1 - IDLE_DASH) * P) * m0
    initialDash.current = `${Math.max(0, dash)} ${Math.max(0, gap)}`
  }

  const writeDash = () => {
    const g = geo.current
    const m = modeTrack.current!.get()
    const a = arcTrack.current!.get()
    const dash = IDLE_DASH * g.P + (a * g.C - IDLE_DASH * g.P) * m
    const gap = (1 - IDLE_DASH) * g.P + ((1 - a) * g.C - (1 - IDLE_DASH) * g.P) * m
    ringRef.current?.setAttribute('stroke-dasharray', `${Math.max(0, dash)} ${Math.max(0, gap)}`)
  }

  useLayoutEffect(() => {
    writeDash()
    ringRef.current?.setAttribute('stroke-dashoffset', String(travelTrack.current!.get()))
  }, [C, P])

  useEffect(() => {
    const mode = modeTrack.current!
    const arc = arcTrack.current!
    const travel = travelTrack.current!
    const offs = [
      mode.onChange(writeDash),
      arc.onChange(writeDash),
      travel.onChange(value => ringRef.current?.setAttribute('stroke-dashoffset', String(value))),
    ]
    return () => {
      offs.forEach(off => off())
      mode.stop()
      arc.stop()
      travel.stop()
    }
  }, [])

  useEffect(() => {
    const mode = modeTrack.current!
    const arc = arcTrack.current!
    const travel = travelTrack.current!
    const g = ++gen.current
    if (reduce) {
      mode.jump(solid ? 1 : 0)
      arc.jump(targetArc)
      travel.jump(0)
      return
    }
    if (mode.get() === 0) arc.jump(targetArc)
    void mode.tween(solid ? 1 : 0, MORPH_MS, MORPH_CURVE)
    void arc.tween(targetArc, UI_MS, UI_CURVE)
    if (indeterminate) {
      travel.spin(-C / Math.max(1, spinDuration))
      return
    }
    const unit = determinate ? C : P
    const to = Math.floor(travel.get() / unit) * unit
    void travel.tween(to, UI_MS, UI_CURVE).then(completed => {
      if (completed && gen.current === g) travel.jump(0)
    })
  }, [status, solid, determinate, indeterminate, targetArc, reduce, C, P, spinDuration])

  const statusText = labels?.[status] ?? DEFAULT_TEXT[status]
  const spoken = statusText + (determinate ? `, ${Math.round(clamp01(progress) * 100)}%` : '')
  const hasLabel = label !== undefined && label !== null

  return (
    <span
      className={`drw-sm${className ? ` ${className}` : ''}`}
      data-status={status}
      data-indeterminate={indeterminate ? '' : undefined}
      data-strike={strike ? '' : undefined}
      style={{
        '--sm-size': `${size}px`,
        '--sm-stroke': strokeWidth,
        '--sm-color': color,
        '--sm-done': doneColor,
        '--sm-error': errorColor,
        '--sm-fill': fillOpacity,
        '--sm-font': `${fontSize}px`,
        '--sm-draw': `${drawDuration}ms`,
        '--sm-strike-delay': `${120 + strikeDelay}ms`,
        ...style,
      } as CSSProperties}
    >
      <svg
        className="drw-sm__glyph"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        role={hasLabel ? undefined : 'img'}
        aria-label={hasLabel ? undefined : spoken}
        aria-hidden={hasLabel || undefined}
      >
        <circle className="drw-sm__track" cx="12" cy="12" r={r} transform="rotate(-90 12 12)" />
        <circle
          ref={ringRef}
          className="drw-sm__ring"
          cx="12"
          cy="12"
          r={r}
          transform="rotate(-90 12 12)"
          strokeDasharray={initialDash.current}
          strokeDashoffset={0}
        />
        <path className="drw-sm__check" d={CHECK} pathLength={1} />
        <path className="drw-sm__cross" d={CROSS} pathLength={1} />
      </svg>
      {hasLabel ? <span className="drw-sm__sr">{spoken}: </span> : null}
      {hasLabel ? (
        <span className="drw-sm__label">
          {label}
          <span className="drw-sm__strike" aria-hidden="true" />
        </span>
      ) : null}
    </span>
  )
}

export default StatusMark
