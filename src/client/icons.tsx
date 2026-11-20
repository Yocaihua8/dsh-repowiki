import type { ReactNode } from 'react'
import {
  IconCheckOutlineRegular,
  IconDeliverDocRegular,
  IconCodeOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconCopyOutlineRegular,
  IconFlatListOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconLoadingOutlineRegular,
  IconSettingsOutlineRegular,
  IconSparkleRegular,
  IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

type IconName = 'chevron-down' | 'chevron-right' | 'check' | 'arrow-left' | 'arrow-right' | 'wiki' | 'writing' | 'failed' | 'settings' | 'document' | 'code' | 'panel' | 'cards' | 'list' | 'sparkle' | 'pause' | 'cancel'

/** Shared book mark so the sidebar panel icon and the in-panel wiki marks stay identical. */
export function WikiBookMark({ size = 24, children }: { size?: number; children?: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    {children}
  </svg>
}

/** Decorative SVGs; the enclosing native control owns the accessible name. */
export function WikiIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  if (name === 'wiki') return <span className="drw-icon" aria-hidden="true" style={{ width: size, height: size }}><WikiBookMark size={size} /></span>
  const Native = name === 'chevron-down' ? IconChevronDownOutlineRegular
    : name === 'chevron-right' ? IconChevronRightOutlineRegular
    : name === 'check' ? IconCheckOutlineRegular
    : name === 'writing' ? IconLoadingOutlineRegular
    : name === 'failed' ? IconWarningTriangleOutlineRegular
    : name === 'settings' ? IconSettingsOutlineRegular
    : name === 'document' ? IconDeliverDocRegular
    : name === 'code' ? IconCodeOutlineRegular
    : name === 'panel' ? IconPanelLeftOutlineRegular
    : name === 'cards' ? IconCopyOutlineRegular
    : name === 'list' ? IconFlatListOutlineRegular
    : name === 'sparkle' ? IconSparkleRegular
    : null
  return <span className="drw-icon" aria-hidden="true" style={{ width: size, height: size }}>
    {Native ? <Native size={size} /> : <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={name === 'pause' || name === 'cancel' ? '1.5' : '1.3'} strokeLinecap="round" strokeLinejoin="round" focusable="false">
      {name === 'arrow-left' ? <path d="M13 8H3m4-4L3 8l4 4" />
        : name === 'pause' ? <path d="M5.5 3.5v9M10.5 3.5v9" />
        : name === 'cancel' ? <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        : <path d="M3 8h10M9 4l4 4-4 4" />}
    </svg>}
  </span>
}
