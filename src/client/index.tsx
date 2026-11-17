/**
 * DSH 仓库维基 — 客户端入口。
 *
 * 把面板页注册进原生壳：`main` keyed slot（整页视图）+ `sidebar.panellist`（左侧导航项），
 * 并挂载 Typert Remote。模式与 ui-schedule 的整页面板完全一致。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ReactElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js'
import { installLocale, t } from './i18n.js'
import { WikiBookMark } from './icons.js'
import { RepoWikiPage } from './page.js'
import styles from './styles.css'
import { watchJobs, useJobs } from './jobs.js'

const PANEL_ID = 'repowiki' as MainPanelId

/** 渲染面板图标：来自宿主 PropsRuntime 的尺寸。 */
export function RepoWikiPanelIcon(props: { size: number }): ReactElement {
  const { jobs } = useJobs()
  const active = jobs.some(j => j.running)
  const latest = jobs[0]
  return (
    <WikiBookMark size={props.size}>
      {(active || latest) && <circle cx="20" cy="4" r="3" fill={active ? 'var(--dsw-alias-brand-primary)' : ['failed','partial','paused','interrupted'].includes(latest?.stage ?? '') ? '#cc8330' : 'currentColor'} stroke="none"><title>{active ? t('badgeGen') : ['failed','partial','paused','interrupted'].includes(latest?.stage ?? '') ? t('failedToast') : latest?.stage === 'cancelled' ? t('cancelled') : t('badgeDone')}</title></circle>}
    </WikiBookMark>
  )
}

export const inject = ['locale', 'remote', 'slots']

/** 挂载 Remote 贡献与原生面板 slots；返回卸载函数。 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const ui = ctx.inject(['locale', 'remote.repowiki', 'remote', 'slots'], scope => {
    installLocale(scope)
    scope.effect(() => watchJobs(scope.remote.repowiki))
    const style = document.createElement('style')
    style.dataset.dshPlugin = 'dsh-repowiki'
    style.textContent = styles
    document.head.append(style)
    scope.effect(() => () => style.remove())
    scope.slots.inject('main', () => scope.slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({ ctx: scope }),
    }, RepoWikiPage))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 15,
      label: () => t('panel'),
    }, RepoWikiPanelIcon))
  })
  try { await ui }
  catch (error) { await ui.dispose(); await unmountRemote(); throw error }
  return async () => { await ui.dispose(); await unmountRemote() }
}
