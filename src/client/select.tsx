import { WikiIcon } from './icons.js'
import { Children, isValidElement, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

/** Host Menu owns popup placement, keyboard navigation and focus restoration. */
export function NativeSelect({ value, disabled, onChange, children, 'aria-label': label }: {
  value: string; disabled?: boolean; onChange: (event: { target: { value: string } }) => void; children: ReactNode; 'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const items = Children.toArray(children).filter(isValidElement).map(child => {
    const props = child.props as { value: string; children: ReactNode; disabled?: boolean }
    return { id: props.value, label: props.children, disabled: props.disabled }
  })
  return <Menu open={open} portal minWidthFromAnchor align="end" selectedId={value} onClose={() => setOpen(false)} items={items}
    onSelect={id => { onChange({ target: { value: id } }); setOpen(false) }} anchor={<Button className="drw-select-trigger" variant="outline" size="sm" disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><span className="drw-select-label">{items.find(i => i.id === value)?.label ?? value}</span> <WikiIcon name="chevron-down" /></Button>} />
}
