import { WikiIcon } from './icons.js'
import { useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelCapabilities, ModelSelection } from '../shared/types.js'

export function ModelPicker({ models, value, onChange, disabled, u, inheritLabel }: { models: ModelCapabilities | null; value: ModelSelection | null; onChange: (value: ModelSelection | null) => void; disabled?: boolean; u: (zh: string, en: string) => string; inheritLabel?: string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  const buttons = useRef<(HTMLButtonElement | null)[]>([]), search = useRef<HTMLInputElement>(null)
  const effective = value ?? models?.defaultModel
  const selected = models?.models.find(m => m.provider === effective?.provider && m.model === effective.model)
  const defaultModel = models?.models.find(m => m.provider === models.defaultModel?.provider && m.model === models.defaultModel.model)
  const key = (m: ModelSelection | null) => m ? JSON.stringify([m.provider, m.model]) : ''
  const choices = [{ key: '', selection: null, name: inheritLabel ?? defaultModel?.name ?? defaultModel?.label ?? u('默认模型不可用', 'Default model unavailable'), source: inheritLabel ? '' : defaultModel?.source ?? '', description: inheritLabel ? '' : defaultModel?.description ?? '', followsDefault: true },
    ...(models?.models ?? []).map(m => ({ key: key(m), selection: { provider: m.provider, model: m.model }, name: m.name ?? m.label, source: m.source ?? '', description: m.description ?? '', followsDefault: false }))]
    .filter(m => `${m.name} ${m.source} ${m.description} ${m.followsDefault ? 'DSH 默认 default' : ''}`.toLowerCase().includes(query.toLowerCase()))
  return <>
    <Button variant="outline" className="drw-model-trigger" aria-label={u('选择生成模型', 'Choose generation model')} aria-haspopup="dialog" disabled={disabled || !models} onClick={() => { setQuery(''); setOpen(true) }}>
      <span className="drw-model-copy">{!value && <small>{inheritLabel ? u('当前生效', 'effective') : u('跟随 DSH 默认模型 · 当前生效', 'DSH default · effective model')}</small>}<strong className="drw-model-title"><span className="drw-model-name">{!value && inheritLabel ? inheritLabel : selected?.name ?? selected?.label ?? u('所选模型不可用', 'Selected model unavailable')}</span>{!value && !inheritLabel && <em className="drw-model-default-badge">{u('默认', 'Default')}</em>}</strong><span>{!value && inheritLabel ? '' : [selected?.source, selected?.description].filter(Boolean).join(' · ')}</span></span><WikiIcon name="chevron-down" />
    </Button>
    <Modal open={open} onClose={() => setOpen(false)} title={u('选择生成模型', 'Choose model')} closeLabel={u('关闭模型选择', 'Close model picker')} description={u('搜索模型、来源或套餐', 'Search model, source or plan')} className="drw-model-dialog">
      <Input ref={search} data-modal-autofocus type="search" aria-label={u('搜索模型、来源或套餐', 'Search model, source or plan')} placeholder={u('搜索模型、来源或套餐…', 'Search model, source or plan…')} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (!e.nativeEvent.isComposing && e.key === 'ArrowDown' && choices.length) { e.preventDefault(); buttons.current[0]?.focus() } }} />
      <div className="drw-model-options">{choices.map((m, i) => <Button key={m.key} ref={el => { buttons.current[i] = el }} variant="ghost" className="drw-model-option" aria-pressed={key(value) === m.key} onClick={() => { onChange(m.selection); setOpen(false) }} onKeyDown={e => {
        if (!e.nativeEvent.isComposing && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const next = i + (e.key === 'ArrowDown' ? 1 : -1); if (next < 0) search.current?.focus(); else buttons.current[Math.min(choices.length - 1, next)]?.focus() }
      }}><span className="drw-model-copy">{m.followsDefault && !inheritLabel && <small>{u('跟随 DSH 默认模型', 'Follow DSH default')}</small>}<strong>{m.name}</strong><span>{[m.source, m.description].filter(Boolean).join(' · ')}</span></span>{key(value) === m.key && <WikiIcon name="check" />}</Button>)}</div>
      {!choices.length && <p className="drw-muted">{u('没有匹配的模型。', 'No matching models.')}</p>}
    </Modal>
  </>
}
