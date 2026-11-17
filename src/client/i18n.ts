/**
 * 客户端 i18n：注册词典、提供 t() 与语言订阅。
 * 形状沿用 dsh-prompt-improver 的 i18n.ts（简化：无 UiMessage 插值）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import { dictionaries, en, zh, type LocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'dsh-repowiki': LocaleKey }
}

const NAMESPACE = 'dsh-repowiki'
let runtime: Context['locale'] | undefined
let translate: ((key: LocaleKey) => string) | undefined
let fallback: 'zh' | 'en' = 'zh'
const listeners = new Set<() => void>()
const notify = (): void => { for (const listener of listeners) listener() }

export const subscribeLocale = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const localeId = (): string => runtime?.getSnapshot().active ?? fallback
export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, localeId, localeId)
}

export function installLocale(ctx: Context): void {
  const dispose = ctx.locale.register(NAMESPACE, dictionaries)
  runtime = ctx.locale
  translate = ctx.locale.bind(NAMESPACE)
  const stop = runtime.subscribe(notify)
  ctx.effect(() => () => {
    stop()
    dispose()
    if (runtime === ctx.locale) { runtime = undefined; translate = undefined }
    notify()
  })
}

export function t(key: LocaleKey): string {
  if (translate) return translate(key)
  return localeId().startsWith('zh') ? zh[key] : en[key]
}
