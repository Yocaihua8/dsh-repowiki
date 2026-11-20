import { Button, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import type { ProjectEntry } from '../shared/types.js'
import { t, useLocale } from './i18n.js'
import { IconDeliverDocRegular, IconBranchOutlineRegular, IconCodeOutlineRegular, IconShareOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
export function I({ name, size = 16 }: { name: string; size?: number }): ReactElement {
  const Icon = name === 'git-branch' ? IconBranchOutlineRegular : name === 'code-xml' ? IconCodeOutlineRegular : name === 'share-2' ? IconShareOutlineRegular : name === 'flower' || name === 'leaf' ? IconSparkleRegular : IconDeliverDocRegular
  return <Icon size={size} />
}

/* ── 初始页 ── */
export function ListPage(props: {
  projects: ProjectEntry[]
  filter: 'all' | 'done' | 'none'
  viewMode: 'grid' | 'list'
  busy: string | null
  onFilter: (filter: 'all' | 'done' | 'none') => void
  onViewMode: (mode: 'grid' | 'list') => void
  onOpen: (index: number) => void
  onGenerate: (index: number) => void
}): ReactElement {
  const zh = useLocale().startsWith('zh')
  const ui = { all: t('filterAll'), done: t('filterDone'), none: t('filterNone') }
  const visible = props.projects
    .map((project, index) => ({ project, index }))
    .filter(item => {
      if (props.filter === 'all') return true
      const generated = item.project.wiki !== null
      return props.filter === 'done' ? generated : !generated
    })
  const stats = (project: ProjectEntry): ReactElement => (
    <div className="drw-cardstats">
      <span className="drw-stat" title={t('statPages')}><I name="file-text" size={13} />{project.wiki?.pages ?? 0}</span>
      <span className="drw-stat" title={t('statRefs')}><I name="git-branch" size={13} />{project.wiki?.refs ?? 0}</span>
    </div>
  )
  const action = (project: ProjectEntry, index: number): ReactElement => project.wiki
    ? <Button variant="outline" size="sm" data-open={index} onClick={() => props.onOpen(index)}>{t('open')}</Button>
    : <Button variant="outline" size="sm" data-generate={index} disabled={props.busy !== null}
        onClick={event => { event.stopPropagation(); props.onGenerate(index) }}>{t('goGenerate')}</Button>
  const badge = (project: ProjectEntry): ReactElement => project.task && (project.task.running || ['failed', 'partial', 'paused', 'interrupted', 'cancelled', 'done'].includes(project.task.stage))
    ? <span className={`drw-badge ${project.task.stage === 'done' ? 'is-done' : ''}`} title={project.task.error?.message ?? project.task.warning ?? ''}>{project.task.stage === 'queued' ? t('queued') : project.task.running ? t('badgeGen') : ['failed','partial'].includes(project.task.stage) ? t('failedToast') : project.task.stage === 'paused' ? (zh ? '已暂停' : 'Paused') : project.task.stage === 'interrupted' ? (zh ? '待恢复' : 'Resume') : project.task.stage === 'cancelled' ? t('cancelled') : t('badgeDone')}</span>
    : project.wiki
    ? <span className="drw-badge is-done">{t('badgeDone')}</span>
    : <span className="drw-badge">{t('badgeNone')}</span>
  const head = (project: ProjectEntry): ReactElement => (
    <div className="drw-cardhead">
      <span className={`drw-cardicon${project.wiki ? ' is-done' : ''}`}><I name="book-open" size={17} /></span>
      <span className="drw-cardname" title={project.path}>{project.name}</span>
    </div>
  )
  const items = visible.map(item => props.viewMode === 'grid'
    ? (
      <div key={item.project.path} className={`drw-card ${item.project.wiki ? 'is-done' : 'is-none'}`}
        onClick={item.project.wiki ? () => props.onOpen(item.index) : undefined}
>
        {head(item.project)}
        {stats(item.project)}
        <div className="drw-cardfoot">{badge(item.project)}{action(item.project, item.index)}</div>
      </div>
    )
    : (
      <div key={item.project.path} className={`drw-row ${item.project.wiki ? 'is-done' : 'is-none'}`}
        onClick={item.project.wiki ? () => props.onOpen(item.index) : undefined}
>
        {head(item.project)}
        {stats(item.project)}
        {badge(item.project)}
        {action(item.project, item.index)}
      </div>
    ))
  return (
    <div>
      <div className="drw-hero">
        <h1 className="drw-hero-title"><span className="drw-hero-accent"><I name="book-open" size={20} />{t('heroBrand')}</span></h1>
      </div>
      <div className="drw-listbar">
        <SegmentedControl id="drw-project-filter" value={props.filter} label={t('filterAll')} options={(['all','done','none'] as const).map(value => ({ value, label: ui[value] }))} onChange={v => props.onFilter(v as typeof props.filter)} />
        <SegmentedControl id="drw-project-layout" value={props.viewMode} label={t('viewGrid')} options={[{ value:'grid',label:t('viewGrid') },{ value:'list',label:t('viewList') }]} onChange={v => props.onViewMode(v as typeof props.viewMode)} />
      </div>
      {items.length === 0
        ? <div className="drw-emptylist">{t('emptyList')}</div>
        : <div className={props.viewMode === 'grid' ? 'drw-cards' : 'drw-rows'}>{items}</div>}
    </div>
  )
}


