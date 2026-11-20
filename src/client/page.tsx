import { citedFiles, sourceLabel, readingCitations } from './reading-evidence.js'
import { routePages, type ReadingRoute } from '../shared/reading.js'
import { ModelPicker } from './model-picker.js'
import { BranchedMenu } from './branched-menu.js'
import type { BranchedMenuChild, BranchedMenuItem, BranchedMenuState } from './branched-menu.js'
import { WikiIcon } from './icons.js'
import { SourceView } from './source.js'
import { GooeyNav } from './gooey-nav.js'
import { Knowledge } from './knowledge.js'
import { MermaidMarkdown } from './mermaid.js'
import { StatusMark } from './status-mark.js'
import { ThoughtLine } from './thought-line.js'
import { buildTaskTrace, formatTaskDeciseconds, generationSettingsEqual, generationSettingsKey, shouldRetryIncrementalLabel, statusToMark } from './task-trace.js'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Button, MarkdownDelegateProvider, Modal, Switch, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GenerationStatus, ModelCapabilities, ModelSelection, ProjectConfiguration, ProjectEntry, ProjectSettings, SourceExcerpt, StoragePlan, WikiManifest, WikiPageMeta } from '../shared/types.js'
import { call, refreshJobs, useJobs, type PanelContext, type RepoWikiRemote } from './jobs.js'
import { ListPage } from './overview.js'
import { t, useLocale } from './i18n.js'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const rememberedPath = () => { try { return sessionStorage.getItem('dsh-repowiki.project') ?? '' } catch { return '' } }
const remember = (path: string) => { try { sessionStorage.setItem('dsh-repowiki.project', path) } catch { /* Storage is optional. */ } }
const stages = { analyze: ['分析仓库', 'Analyzing'], cards: ['提炼知识卡片', 'Extracting cards'], verify: ['核验依据', 'Verifying'], paused: ['已暂停', 'Paused'], interrupted: ['重启待恢复', 'Awaiting recovery'], partial: ['部分失败', 'Partial failure'], idle: ['未开始', 'Idle'], queued: ['排队中', 'Queued'], scan: ['扫描源码', 'Scanning'], plan: ['规划目录', 'Planning'], pages: ['生成页面', 'Writing pages'], write: ['保存版本', 'Saving'], export: ['导出文件', 'Exporting'], done: ['已完成', 'Completed'], failed: ['生成失败', 'Failed'], cancelled: ['已取消', 'Cancelled'] } as const
function useText() { const zh = useLocale().startsWith('zh'); return (cn: string, en: string) => zh ? cn : en }
function Stage({ status }: { status: GenerationStatus }): ReactElement {
  const u = useText()
  if (status.running && status.currentAction?.startsWith('修订 ')) return <span className="drw-jobstage">{u('修订中', 'Revising')}</span>
  if (status.running && status.currentAction?.startsWith('核验 ')) return <span className="drw-jobstage">{u('核验中', 'Reviewing')}</span>
  return <span className={`drw-jobstage drw-job-${status.stage}`}>{u(stages[status.stage][0], stages[status.stage][1])}</span>
}

function RetryStatus({ status }: { status: GenerationStatus }) {
  const u = useText(), [, tick] = useState(0)
  useEffect(() => { const timer = window.setInterval(() => tick(v => v + 1), 1000); return () => window.clearInterval(timer) }, [])
  if (!status.waiting) return null
  return <>{status.waiting.reason} · {u('重试', 'Retry')} {status.waiting.attempt}/3 · {Math.max(0, Math.ceil((Date.parse(status.waiting.retryAt) - Date.now()) / 1000))}s</>
}

function Progress({ status, onCancel, onPause, onResume, busy, modelLabel, actions }: { modelLabel?: string; status: GenerationStatus; onCancel: () => void; onPause: () => void; onResume: () => void; busy: boolean; actions?: ReactNode }): ReactElement {
  const u = useText()
  const [, clock] = useState(0)
  useEffect(() => {
    if (!status.running) return undefined
    const timer = window.setInterval(() => clock(n => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [status.running])
  const elapsed = status.startedAt ? Math.max(0, Math.floor(((status.finishedAt ? Date.parse(status.finishedAt) : Date.now()) - Date.parse(status.startedAt)) / 1000)) : 0
  const mark = statusToMark(status)
  const trace = buildTaskTrace(status, u)
  const markLabels = {
    pending: u('等待中', 'Pending'),
    running: u('生成中', 'In progress'),
    done: u('已完成', 'Completed'),
    failed: u('生成失败', 'Failed'),
    cancelled: u('已取消', 'Cancelled'),
  }
  const failedItems = status.items?.filter(i => i.state === 'failed') ?? []
  const metaFooter = (
    <div className="drw-task-meta">
      <p><span>{u('模型', 'Model')}</span>{modelLabel ?? '—'}{status.model?.reasoningEffort ? ` · ${status.model.reasoningEffort}` : ''}</p>
      <p><span>{u('最近保存', 'Last saved')}</span>{status.checkpointAt ? new Date(status.checkpointAt).toLocaleString() : '—'}</p>
      {!status.error && !status.running && status.plannerHint && <p className="drw-task-hint">{status.plannerHint.lastError}</p>}
      {!!failedItems.length && (
        <div className="drw-task-failed">
          {failedItems.map(i => (
            <p key={i.id} className="drw-task-failed-item">
              <StatusMark status="failed" size={14} strokeWidth={2} strike={false} labels={markLabels} />
              <span>{i.title}{i.error ? ` · ${i.error}` : ''}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
  const hasHeaderActions = Boolean(actions) || (status.running && !status.result) || (!status.running && status.recoverable)
  return <section className="drw-progress drw-task-summary">
    <div className="drw-task-header">
      <div className="drw-task-header-main">
        <span className="drw-section-label">{u('当前任务', 'Current task')}</span>
        <div className="drw-task-headline">
          <StatusMark
            status={mark.status}
            progress={mark.progress}
            color={status.running ? 'var(--drw-brand)' : 'currentColor'}
            size={22}
            strokeWidth={2}
            strike={false}
            labels={markLabels}
          />
          <h2><Stage status={status} /></h2>
        </div>
      </div>
      {hasHeaderActions && (
        <div className="drw-actions drw-task-actions">
          {actions}
          {status.running && !status.result && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="drw-task-iconbtn"
                disabled={busy}
                aria-label={u('暂停任务', 'Pause task')}
                title={u('暂停任务', 'Pause task')}
                onClick={onPause}
              >
                <WikiIcon name="pause" size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="drw-task-iconbtn"
                disabled={busy}
                aria-label={u('取消任务', 'Cancel task')}
                title={u('取消任务', 'Cancel task')}
                onClick={onCancel}
              >
                <WikiIcon name="cancel" size={14} />
              </Button>
            </>
          )}
          {!status.running && status.recoverable && (
            <Button variant="primary" disabled={busy} onClick={onResume}>
              {['failed', 'partial'].includes(status.stage) ? u('重试未完成项', 'Retry unfinished') : u('继续任务', 'Resume')}
            </Button>
          )}
        </div>
      )}
    </div>
    {!!status.pagesTotal && (
      <div className="drw-task-progress-row">
        <p className="drw-muted drw-task-count">{status.pagesDone} / {status.pagesTotal} {u('页已生成', 'pages generated')}{!!status.cardsDone && ` · ${status.cardsDone} ${u('张知识卡片', 'cards')}`}</p>
        {status.running && mark.progress !== undefined && <span className="drw-muted drw-task-percent">{Math.round(mark.progress * 100)}%</span>}
      </div>
    )}
    {status.running && <progress aria-label={u('生成进度', 'Generation progress')} max={status.pagesTotal + 1} value={status.pagesTotal ? status.pagesDone + (status.result ? 1 : 0) : undefined} />}
    <div className="drw-task-trace">
      <ThoughtLine
        working={status.running}
        label={trace.label}
        doneLabel={trace.doneLabel}
        steps={trace.steps}
        elapsed={elapsed}
        formatTime={formatTaskDeciseconds}
        fontSize={13}
        collapsible
        collapseOnSettle
        showTimer
        footer={metaFooter}
      />
    </div>
    {status.waiting && <p className="drw-notice"><RetryStatus status={status} /></p>}
    {status.error && <p role="alert" className="drw-alert">{status.error.message}</p>}
    {status.warning && <p role="status" className="drw-notice">{status.warning}</p>}
  </section>
}

type AutoSaveSwitchKey = 'autoUpdate' | 'autoExport' | 'agentReference'

/** 生成设置里的 GooeyNav 选择器：把字符串/数字值映射到组件下标。 */
function GooeySetting<T extends string | number>({ value, options, onChange, ariaLabel, disabled = false }: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
}): ReactElement {
  const found = options.findIndex(option => option.value === value)
  return <GooeyNav
    items={options.map(option => ({ label: option.label }))}
    activeIndex={found < 0 ? 0 : found}
    onChange={index => { const option = options[index]; if (option) onChange(option.value) }}
    theme="auto"
    size="sm"
    frame
    particleCount={12}
    spread={36}
    animationTime={520}
    timeVariance={220}
    gooeyness={0.55}
    wobble={0.45}
    ariaLabel={ariaLabel}
    mode="selection"
    disabled={disabled}
    className="drw-gn-setting"
  />
}

function Configuration({ config, models, busy, running, project, wiki, remote, onSave, onToggleSwitch, onReloadModels }: {
  config: ProjectConfiguration; models: ModelCapabilities | null; busy: boolean; running: boolean; remote: RepoWikiRemote
  project: ProjectEntry; wiki: WikiManifest | null
  onSave: (settings: ProjectSettings, start: boolean) => void
  onToggleSwitch: (key: AutoSaveSwitchKey, value: boolean) => Promise<void>
  onReloadModels: () => void
}): ReactElement {
  const u = useText()
  const [settings, setSettings] = useState(config.settings)
  const [modelNotice, setModelNotice] = useState('')
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [optimisticSwitches, setOptimisticSwitches] = useState<Partial<Record<AutoSaveSwitchKey, boolean>>>({})
  const [savingSwitch, setSavingSwitch] = useState<AutoSaveSwitchKey | null>(null)
  const [savedSwitch, setSavedSwitch] = useState<AutoSaveSwitchKey | null>(null)
  const savedTimer = useRef<number | undefined>(undefined)
  const configGenKey = generationSettingsKey(config.settings)
  useEffect(() => {
    setSettings(config.settings)
    setModelNotice('')
  }, [config.path, configGenKey])
  useEffect(() => {
    setOptimisticSwitches({})
    setSavingSwitch(null)
    setSavedSwitch(null)
    setConfirmRegen(false)
  }, [config.path])
  useEffect(() => () => { if (savedTimer.current) window.clearTimeout(savedTimer.current) }, [])
  const change = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) => setSettings(s => ({ ...s, [key]: value }))
  const changeRole = (role: 'planner' | 'writer' | 'verifier', value: ModelSelection | null) => setSettings(s => ({ ...s, roles: { ...(s.roles ?? {}), [role]: value } }))
  const changeModel = (value: ModelSelection | null) => {
    if (!value) { setModelNotice(''); change('model', null); return }
    const option = models?.models.find(model => model.provider === value.provider && model.model === value.model)
    const same = settings.model?.provider === value.provider && settings.model?.model === value.model
    const prior = same ? settings.model?.reasoningEffort : undefined
    const effort = prior && option?.efforts.includes(prior) ? prior : undefined
    setModelNotice(prior && !effort ? u('新模型不支持原思考强度，已改为模型默认。', 'The new model does not support the previous reasoning effort; using the model default.') : '')
    change('model', { provider: value.provider, model: value.model, ...(effort ? { reasoningEffort: effort } : {}) })
  }
  const toggleInstant = (key: AutoSaveSwitchKey, value: boolean) => {
    setOptimisticSwitches(prev => ({ ...prev, [key]: value }))
    setSavingSwitch(key)
    setSavedSwitch(current => (current === key ? null : current))
    void onToggleSwitch(key, value).then(() => {
      setOptimisticSwitches(prev => { const next = { ...prev }; delete next[key]; return next })
      setSavedSwitch(key)
      if (savedTimer.current) window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSavedSwitch(current => (current === key ? null : current)), 1800)
    }).catch(() => {
      setOptimisticSwitches(prev => { const next = { ...prev }; delete next[key]; return next })
    }).finally(() => {
      setSavingSwitch(current => (current === key ? null : current))
    })
  }
  const effective = settings.model ?? models?.defaultModel
  const selected = models?.models.find(m => m.provider === effective?.provider && m.model === effective.model)
  const hasWiki = !!(wiki || project.wiki)
  const isDirty = !generationSettingsEqual(settings, config.settings)
  const mergedSettings: ProjectSettings = {
    ...config.settings,
    language: settings.language,
    granularity: settings.granularity,
    model: settings.model,
    maxPages: settings.maxPages,
    collaboration: settings.collaboration,
    concurrency: settings.concurrency,
    roles: settings.roles,
    exclude: settings.exclude,
  }
  const autoUpdateChecked = optimisticSwitches.autoUpdate ?? config.settings.autoUpdate
  const autoExportChecked = optimisticSwitches.autoExport ?? config.settings.autoExport
  const agentRefChecked = optimisticSwitches.agentReference ?? (config.settings.agentReference === true)
  const switchDisabled = busy || savingSwitch !== null
  return <section className="drw-config drw-overview">
    <h2>{u('生成设置', 'Generation settings')}</h2>
    <div className="drw-setting"><span>{u('语言', 'Language')}</span><GooeySetting value={settings.language} options={[{ value: 'zh', label: '简体中文' }, { value: 'en', label: 'English' }] as const} onChange={v => change('language', v)} ariaLabel={u('生成语言', 'Language')} disabled={busy} /></div>
    <div className="drw-setting"><span>{u('目录粒度', 'Granularity')}<small>{u('标准约 18–26 页；深度会按子系统细拆并更耗时', 'Standard ~18–26 pages; deep splits subsystems further')}</small></span><GooeySetting value={settings.granularity ?? 'standard'} options={[{ value: 'standard', label: u('标准', 'Standard') }, { value: 'deep', label: u('深度', 'Deep') }] as const} onChange={v => change('granularity', v)} ariaLabel={u('目录粒度', 'Granularity')} disabled={busy} /></div>
    <div className="drw-setting drw-model-field"><span>{u('生成模型', 'Model')}</span><ModelPicker models={models} value={settings.model} onChange={changeModel} disabled={busy} u={u} /></div>
    {modelNotice && <p className="drw-notice">{modelNotice}</p>}
    <div className="drw-setting"><span>{u('自动更新', 'Auto update')}<small>{!config.git.available ? u('仅支持已有提交的 Git 仓库', 'Requires a Git repository with commits') : u('Git 有新提交时在后台自动增量更新', 'Automatically update when new Git commits appear')}</small></span><div className="drw-switch-cell">{savedSwitch === 'autoUpdate' && <span className="drw-switch-saved" role="status">{u('已保存', 'Saved')}</span>}<Switch label={u('自动更新', 'Auto update')} checked={autoUpdateChecked} disabled={!config.git.available || switchDisabled} onChange={v => toggleInstant('autoUpdate', v)} /></div></div>
    <div className="drw-setting"><span>{u('自动导出', 'Auto export')}<small>{u(`自动导出 Markdown 至 .dsh/repowiki/${settings.language}/`, `Export Markdown to .dsh/repowiki/${settings.language}/`)}</small></span><div className="drw-switch-cell">{savedSwitch === 'autoExport' && <span className="drw-switch-saved" role="status">{u('已保存', 'Saved')}</span>}<Switch label={u('自动导出', 'Auto export')} checked={autoExportChecked} disabled={switchDisabled} onChange={v => toggleInstant('autoExport', v)} /></div></div>
    <div className="drw-setting"><span>{u('自动引用', 'Automatic references')}<small>{u('对话时自动向主会话注入相关知识卡片', 'Inject relevant knowledge cards into main sessions')}</small></span><div className="drw-switch-cell">{savedSwitch === 'agentReference' && <span className="drw-switch-saved" role="status">{u('已保存', 'Saved')}</span>}<Switch label={u('自动引用', 'Automatic references')} checked={agentRefChecked} disabled={switchDisabled} onChange={v => toggleInstant('agentReference', v)} /></div></div>
    <details className="drw-advanced-settings"><summary>{u('高级设置', 'Advanced settings')}</summary>
      <div className="drw-setting"><span>{u('协作生成', 'Collaborative generation')}</span><Switch label={u('协作生成', 'Collaborative generation')} checked={settings.collaboration !== 'single'} disabled={busy} onChange={v => change('collaboration', v ? 'collaborative' : 'single')} /></div>
      {settings.collaboration !== 'single' && <>
        <div className="drw-setting"><span>{u('并发子代理', 'Subagent concurrency')}</span><GooeySetting value={settings.concurrency ?? 2} options={[{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }] as const} onChange={v => change('concurrency', v)} ariaLabel={u('并发子代理', 'Subagent concurrency')} disabled={busy} /></div>
        <div className="drw-setting drw-model-field"><span>{u('规划模型', 'Planner model')}</span><ModelPicker models={models} value={settings.roles?.planner ?? null} onChange={v => changeRole('planner', v)} disabled={busy} u={u} inheritLabel={u('跟随项目模型', 'Follow project model')} /></div>
        <div className="drw-setting drw-model-field"><span>{u('写作模型', 'Writer model')}</span><ModelPicker models={models} value={settings.roles?.writer ?? null} onChange={v => changeRole('writer', v)} disabled={busy} u={u} inheritLabel={u('跟随项目模型', 'Follow project model')} /></div>
        <div className="drw-setting drw-model-field"><span>{u('核验模型', 'Verifier model')}</span><ModelPicker models={models} value={settings.roles?.verifier ?? null} onChange={v => changeRole('verifier', v)} disabled={busy} u={u} inheritLabel={u('跟随项目模型', 'Follow project model')} /></div>
      </>}
      {!!selected?.efforts.length && <div className="drw-setting"><span>{u('思考强度', 'Reasoning effort')}</span><GooeySetting value={effective?.reasoningEffort ?? ''} options={[{ value: '', label: u('模型默认', 'Model default') }, ...selected.efforts.map(e => ({ value: e, label: selected.effortOptions?.find(o => o.id === e)?.name ?? e }))]} onChange={v => change('model', { provider: selected.provider, model: selected.model, reasoningEffort: v || undefined })} ariaLabel={u('思考强度', 'Reasoning effort')} disabled={busy} /></div>}
      <StoragePanel remote={remote} u={u} />
      <Button variant="ghost" size="sm" disabled={busy} onClick={onReloadModels}>{u('刷新模型列表', 'Refresh models')}</Button>
    </details>
    {models?.warnings.map(w => <p className="drw-notice" key={w}>{w}</p>)}

    {!config.canGenerate && <p role="status" className="drw-notice">{config.reason}</p>}
    {config.updateNotice && <p className="drw-notice">{config.updateNotice}</p>}
    <div className="drw-actions drw-settings-save">
      {isDirty && <span className="drw-dirty-hint">{u('生成参数有未保存的更改', 'Unsaved generation settings')}</span>}
      <Button variant={hasWiki && isDirty ? 'primary' : 'outline'} disabled={busy || savingSwitch !== null || !isDirty} onClick={() => onSave(mergedSettings, false)}>{u('保存设置', 'Save settings')}</Button>
      {!running && (hasWiki
        ? <Button variant="outline" disabled={busy || savingSwitch !== null || !config.canGenerate || !models || !!settings.model && !selected} onClick={() => setConfirmRegen(true)}>{u('全量重新生成', 'Regenerate all')}</Button>
        : <Button variant="primary" disabled={busy || savingSwitch !== null || !config.canGenerate || !models || !!settings.model && !selected} onClick={() => onSave(mergedSettings, true)}>{u('开始生成', 'Generate')}</Button>)}
    </div>
    <Modal
      open={confirmRegen}
      onClose={() => setConfirmRegen(false)}
      tone="warning"
      title={u('确认全量重新生成？', 'Regenerate entire Wiki?')}
      closeLabel={u('关闭确认框', 'Close confirmation')}
      description={u('将基于当前设置从头重新扫描仓库并覆盖现有版本；若仅需同步近期代码变更，建议取消并点击上方「增量更新」。', 'This rebuilds the entire Wiki from scratch using current settings and replaces the published version. Use Incremental update above to only sync recent changes.')}
      className="drw-confirm-dialog"
      footer={
        <div className="drw-confirm-actions">
          <Button variant="outline" data-modal-autofocus onClick={() => setConfirmRegen(false)}>{u('取消', 'Cancel')}</Button>
          <Button variant="primary" disabled={busy || savingSwitch !== null} onClick={() => { setConfirmRegen(false); onSave(mergedSettings, true) }}>{u('确认重新生成', 'Regenerate')}</Button>
        </div>
      }
    />
  </section>
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB'] as const
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  return idx === 0 ? `${Math.round(value)} B` : `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`
}

function StoragePanel({ remote, u }: { remote: RepoWikiRemote; u: (zh: string, en: string) => string }) {
  const [plan, setPlan] = useState<StoragePlan | null>(null), [notice, setNotice] = useState(''), [working, setWorking] = useState(false)
  const scan = () => { setWorking(true); setNotice(''); void call(remote.getStoragePlan(AbortSignal.timeout(20000))).then(setPlan).catch(error => setNotice(message(error))).finally(() => setWorking(false)) }
  const prune = () => {
    if (!plan?.candidates.length || working) return
    setWorking(true); setNotice('')
    void call(remote.pruneStorage({ keepJobs: 20, keepRevisions: 3, olderThanDays: 30 }, AbortSignal.timeout(30000))).then(result => {
      const removed = result.candidates.length
      setPlan({ ...result, candidates: [], jobs: 0, revisions: 0, bytes: 0 })
      setNotice(u(`已清理 ${removed} 项旧任务/版本。`, `Removed ${removed} old job/revision directories.`))
    }).catch(error => setNotice(message(error))).finally(() => setWorking(false))
  }
  return <div className="drw-settings drw-storage">
    <div className="drw-setting"><span>{u('本地数据', 'Local data')}</span><div className="drw-actions"><Button variant="outline" size="sm" disabled={working} onClick={scan}>{u('检查可清理数据', 'Check cleanup')}</Button>{!!plan?.candidates.length && <Button variant="outline" size="sm" disabled={working} onClick={prune}>{u('清理', 'Clean up')}</Button>}</div></div>
    {plan && <p className="drw-muted">{u('可清理', 'Cleanable')}：{plan.jobs} {u('个旧任务', 'jobs')} · {plan.revisions} {u('个旧版本', 'revisions')} · {formatBytes(plan.bytes)}</p>}
    {notice && <p className="drw-notice">{notice}</p>}
  </div>
}


function Detail({ remote, project, task, onBack, reload }: { remote: RepoWikiRemote; project: ProjectEntry; task?: GenerationStatus; onBack: () => void; reload: () => Promise<void> }): ReactElement {
  const u = useText()
  const [config, setConfig] = useState<ProjectConfiguration | null>(null)
  const [models, setModels] = useState<ModelCapabilities | null>(null)
  const [loadedWiki, setLoadedWiki] = useState<{ target: string; wiki: WikiManifest | null } | null>(null)
  type View = 'manage' | 'read' | 'cards'
  const [mode, setMode] = useState<View>(() => {
    try { const saved = sessionStorage.getItem(`dsh-repowiki.view:${project.path}`); if (saved === 'read' || saved === 'cards') return saved; if (saved && ['manage','config','progress','references'].includes(saved)) return 'manage' } catch { /* Optional storage. */ }
    return task?.running ? 'manage' : project.wiki ? 'read' : 'manage'
  })
  useEffect(() => { try { sessionStorage.setItem(`dsh-repowiki.view:${project.path}`, mode) } catch { /* Optional storage. */ } }, [mode, project.path])
  const positionKey = `dsh-repowiki.position:${project.path}`
  const [pageId, setPageId] = useState(() => { try { return sessionStorage.getItem(positionKey) ?? '' } catch { return '' } })
  const [draftMode, setDraftMode] = useState(!!task && task.stage !== 'done')
  useEffect(() => { if (task && !task.result) setDraftMode(true) }, [task?.jobId])
  const publishedWikiId = task?.result?.wikiId ?? project.wiki?.id
  const wikiTarget = draftMode && task?.jobId ? `draft:${task.jobId}` : `published:${publishedWikiId ?? ''}`
  // A version switch must not route the previous manifest to the new RPC.
  const wiki = loadedWiki?.target === wikiTarget ? loadedWiki.wiki : null
  const [route] = useState<ReadingRoute>(() => { try { const v = sessionStorage.getItem(`${positionKey}:route`); return v === 'user' || v === 'developer' || v === 'maintainer' ? v : 'all' } catch { return 'all' } })
  const [directoryHidden, setDirectoryHidden] = useState(() => { try { return sessionStorage.getItem(`${positionKey}:directory`) === 'hidden' } catch { return false } })
  const sourceRequest = useRef(0)
  const sourceAbort = useRef<AbortController | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceRetry, setSourceRetry] = useState<{ id: string; line: number } | null>(null)
  const sourceTarget = useRef<HTMLElement>(null)
  const sourceIntent = useRef(false)
  const [readerTab, setReaderTab] = useState('document')
  const [sourceLine, setSourceLine] = useState(1)
  const [body, setBody] = useState('')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ id: string; snippet: string }[] | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const initializedCollapse = useRef('')
  const [source, setSource] = useState<SourceExcerpt | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const article = useRef<HTMLElement>(null)
  const main = useRef<HTMLElement>(null)
  const [wideOutline, setWideOutline] = useState(true)
  useLayoutEffect(() => {
    if (!main.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWideOutline(entry.contentRect.width > 850)
    })
    observer.observe(main.current)
    return () => observer.disconnect()
  }, [])
  const scrollKey = `${positionKey}:${wikiTarget}:${wiki?.revision ?? ''}:${pageId}:${mode}:${readerTab}`
  const scrollPosition = useRef({ key: '', top: 0, ready: false })
  if (scrollPosition.current.key !== scrollKey) {
    let top = 0
    try { top = Number(sessionStorage.getItem(scrollKey) ?? 0) } catch { /* Optional storage. */ }
    scrollPosition.current = { key: scrollKey, top, ready: false }
  }
  useLayoutEffect(() => {
    const el = main.current, position = scrollPosition.current
    position.ready = false
    if (!el || mode === 'read' && !body) return
    const top = position.top
    const explicitSourceNavigation = sourceIntent.current && readerTab === 'sources'
    // Native Markdown and its heading navigation finish layout after the RPC body arrives.
    // Ignore temporary scroll-to-zero events until content can restore the saved position.
    let observer: ResizeObserver | undefined
    const restore = (settled = false) => {
      if (position !== scrollPosition.current || position.ready) return
      if (explicitSourceNavigation) { position.ready = true; observer?.disconnect(); return }
      el.scrollTop = top
      if (settled || el.scrollHeight - el.clientHeight >= top) { position.ready = true; observer?.disconnect() }
    }
    observer = new ResizeObserver(() => restore())
    observer.observe(article.current ?? el)
    const frame = requestAnimationFrame(() => restore())
    const timer = window.setTimeout(() => restore(true), 250)
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); observer?.disconnect() }
  }, [body, scrollKey, mode])
  const [headings, setHeadings] = useState<{ text: string; id: string; level: number }[]>([])
  const citationOrigin = useRef<HTMLElement | null>(null)
  const labels = useMemo(() => ({ code: { copyLabel: u('复制', 'Copy'), copiedLabel: u('已复制', 'Copied') }, footnotes: u('注释', 'Footnotes') }), [u('复制', 'Copy')])
  const act = async (operation: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await operation() } catch (e) { setError(message(e)) } finally { setBusy(false) } }
  const switchQueue = useRef(Promise.resolve())
  const configRef = useRef(config)
  configRef.current = config
  const toggleSwitch = (key: AutoSaveSwitchKey, value: boolean): Promise<void> => {
    const operation = switchQueue.current.catch(() => {}).then(async () => {
      const base = configRef.current
      if (!base) return
      setError('')
      setNotice('')
      try {
        const updated = await call(remote.saveProjectConfig({ path: project.path, settings: { ...base.settings, [key]: value } }))
        configRef.current = updated
        setConfig(updated)
      } catch (e) {
        setError(message(e))
        throw e
      }
    })
    switchQueue.current = operation
    return operation
  }
  useEffect(() => {
    const controller = new AbortController()
    void call(remote.getProjectConfig({ path: project.path }, controller.signal))
      .then(c => { if (!controller.signal.aborted) setConfig(c) }).catch(e => { if (!controller.signal.aborted) setError(message(e)) })
    void call(remote.getModelCapabilities(AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])))
      .then(m => { if (!controller.signal.aborted) setModels(m) }).catch(e => { if (!controller.signal.aborted) setError(message(e)) })
    return () => controller.abort()
  }, [remote, project.path])
  useEffect(() => {
    const wikiId = task?.result?.wikiId ?? project.wiki?.id
    if (!wikiId && !task?.jobId) return
    const controller = new AbortController()
    const request = draftMode && task?.jobId ? remote.readDraft({ jobId: task.jobId }, controller.signal) : remote.readWiki({ wikiId: wikiId! }, controller.signal)
    void call<{ wiki: WikiManifest | null }>(request).then(({ wiki: w }) => {
      if (!controller.signal.aborted) {
        setLoadedWiki({ target: wikiTarget, wiki: w })
        if (w) {
          setPageId(p => w.pages.some(entry => entry.id === p && entry.kind !== 'group' && entry.bytes > 0) ? p : w.pages.find(entry => entry.kind !== 'group' && entry.bytes > 0)?.id ?? '')
          const collapseKey = `${wikiTarget}:${w.revision ?? ''}`
          if (initializedCollapse.current !== collapseKey) {
            initializedCollapse.current = collapseKey
            if (w.pages.length > 18) {
              const hasChild = new Set(w.pages.map(entry => entry.parentId).filter((id): id is string => !!id))
              setCollapsed(new Set(w.pages.filter(entry => entry.parentId && hasChild.has(entry.id)).map(entry => entry.id)))
            } else setCollapsed(new Set())
          }
        }
      }
    }).catch(e => { if (!controller.signal.aborted) setError(message(e)) })
    return () => controller.abort()
  }, [remote, wikiTarget, project.wiki?.updatedAt, task?.finishedAt, draftMode ? `${task?.outlineVersion ?? 0}:${task?.pagesDone ?? 0}:${task?.checkpointAt ?? ''}` : null])
  useEffect(() => {
    sourceRequest.current++; sourceAbort.current?.abort(); setSourceLoading(false); setSourceRetry(null); sourceIntent.current = false
    setBody(''); setSource(null)
    if (!wiki || !pageId) return
    const controller = new AbortController()
    try { sessionStorage.setItem(positionKey, pageId) } catch { /* Optional storage. */ }
    if (draftMode && !wiki.pages.find(p => p.id === pageId)?.bytes) { setBody(u('此页面正在生成，已完成页面可立即阅读。', 'This page is pending. Completed pages are available to read.')); return }
    void call(draftMode && task?.jobId ? remote.readDraftPage({ jobId: task.jobId, pageId }, controller.signal) : remote.readPage({ wikiId: wiki.id, pageId, revision: wiki.revision }, controller.signal)).then(({ page }) => { if (!controller.signal.aborted) setBody(page.content) }).catch(e => { if (!controller.signal.aborted) setError(message(e)) })
    return () => controller.abort()
  }, [remote, wiki?.id, wiki?.revision, wiki?.pages.find(p => p.id === pageId)?.contentVersion, wiki?.pages.find(p => p.id === pageId)?.bytes, pageId, draftMode])
  useEffect(() => {
    if (!wiki || !query.trim()) { setMatches(null); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => { void call(draftMode && task?.jobId ? remote.searchDraft({ jobId: task.jobId, query }, controller.signal) : remote.searchWiki({ wikiId: wiki.id, query }, controller.signal)).then(r => { if (!controller.signal.aborted) setMatches(r.pages) }).catch(e => { if (!controller.signal.aborted) setError(message(e)) }) }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [remote, wiki, query, draftMode])
  useEffect(() => {
    const nodes = article.current?.querySelectorAll('h2,h3') ?? []
    setHeadings(Array.from(nodes).map((node, i) => { const id = `drw-heading-${i}`; node.id = id; return { text: node.textContent ?? '', id, level: Number(node.tagName.slice(1)) } }))
  }, [body, mode, readerTab])
  const navigatePage = (id: string) => { sourceRequest.current++; sourceAbort.current?.abort(); sourceIntent.current = false; setSource(null); setSourceLoading(false); setSourceRetry(null); setPageId(id); setMode('read'); setReaderTab('document') }
  const openSource = async (id: string, line = 1) => {
    if (!wiki) return
    const request = ++sourceRequest.current
    sourceAbort.current?.abort()
    const controller = new AbortController(); sourceAbort.current = controller
    setSource(null); setError(''); setSourceRetry({ id, line }); setSourceLoading(true); sourceIntent.current = true
    setMode('read'); setReaderTab('sources')
    try {
      const result = await call(draftMode && task?.jobId ? remote.readDraftSource({ jobId: task.jobId, sourceId: id }, controller.signal) : remote.readSource({ wikiId: wiki.id, revision: wiki.revision, sourceId: id }, controller.signal))
      if (request !== sourceRequest.current || controller.signal.aborted) return
      setSource(result.source); setSourceLine(line); setSourceRetry(null)
    } catch (e) { if (request === sourceRequest.current && !controller.signal.aborted) setError(message(e)) }
    finally { if (request === sourceRequest.current) setSourceLoading(false) }
  }
  useEffect(() => () => { sourceRequest.current++; sourceAbort.current?.abort() }, [])
  useLayoutEffect(() => {
    if (readerTab !== 'sources' || !sourceIntent.current) return
    const frame = requestAnimationFrame(() => {
      if (!sourceTarget.current || !main.current) return
      main.current.scrollTop += sourceTarget.current.getBoundingClientRect().top - main.current.getBoundingClientRect().top - 12
      if (!sourceLoading) sourceIntent.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [readerTab, source, sourceLoading])

  const page = wiki?.pages.find(p => p.id === pageId)
  const documentBody = body.replace(/^\s*# [^\n]*(?:\r?\n|$)/, '')
  const references = citedFiles(body, page?.sources ?? [])
  const sourcePaths = [...new Set((page?.sources ?? []).map(source => source.path))]
  const reading = readingCitations(documentBody, sourcePaths)
  const returnToCitation = () => {
    sourceIntent.current = false; setReaderTab('document')
    requestAnimationFrame(() => citationOrigin.current?.focus({ preventScroll: true }))
  }
  const revealFile = (path: string) => {
    citationOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').split(/:(?:L)?\d/)[0]
    const requestedLine = Number(path.match(/:L?(\d+)/)?.[1] ?? 0)
    const citation = page?.sources?.find(s => (s.path === normalized || normalized?.endsWith(`/${s.path}`)) && (!requestedLine || requestedLine >= s.startLine && requestedLine <= s.endLine))
    if (citation) openSource(citation.id, Number(path.match(/:L?(\d+)/)?.[1] ?? citation.startLine))
    else setNotice(u('此文件没有已保存的引用片段。', 'No saved source excerpt is available for this file.'))
  }
  const treePages = wiki?.pages ?? []
  const visible = new Set(matches?.map(m => m.id))
  if (matches && wiki) for (const match of matches) {
    let current = treePages.find(p => p.id === match.id); const seen = new Set<string>()
    while (current?.parentId && !seen.has(current.id)) { seen.add(current.id); visible.add(current.parentId); current = treePages.find(p => p.id === current?.parentId) }
    if (current?.kind === 'group') {
      const queue = [current.id]
      while (queue.length) { const parent = queue.pop()!; for (const child of treePages.filter(p => p.parentId === parent)) if (!visible.has(child.id)) { visible.add(child.id); queue.push(child.id) } }
    }
  }
  const childrenOf = (parent: string) => treePages.filter(p => p.parentId === parent)
  const activePath = new Set<string>()
  let activeWalker = page
  const activeSeen = new Set<string>()
  while (activeWalker?.parentId && !activeSeen.has(activeWalker.id)) { activeSeen.add(activeWalker.id); activePath.add(activeWalker.parentId); activeWalker = treePages.find(p => p.id === activeWalker?.parentId) }
  const menuItems = (() => {
    const items: BranchedMenuItem[] = []
    const collect = (parent: WikiPageMeta, depth: number, kids: BranchedMenuChild[], seen: Set<string>) => {
      for (const child of childrenOf(parent.id)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        if (matches && !visible.has(child.id)) continue
        const group = child.kind === 'group'
        if (!group) {
          const item = task?.items?.find(entry => entry.id === child.id)
          const savedState = item?.bodyState ?? (child.bytes ? 'complete' : item?.state ?? 'pending')
          const state = savedState === 'writing' && !task?.running ? 'pending' : savedState
          const pending = !child.bytes
          const status = state === 'writing' ? u('生成中', 'Writing') : state === 'failed' ? u('失败', 'Failed') : u('待生成', 'Pending')
          const hasChildren = childrenOf(child.id).length > 0
          const expanded = !collapsed.has(child.id) || !!matches || activePath.has(child.id)
          const nodeState: BranchedMenuState = pending ? (state === 'writing' ? 'writing' : state === 'failed' ? 'failed' : 'pending') : 'ready'
          kids.push({
            value: child.id,
            label: child.title,
            title: pending ? `${child.title} · ${status}` : child.title,
            depth,
            state: nodeState,
            disabled: pending,
            badge: draftMode && pending ? <small className={`${state === 'failed' ? 'drw-node-warning' : ''}${state === 'writing' ? ' drw-node-loading' : ''}`} aria-hidden="true">{state === 'writing' ? <WikiIcon name="writing" size={12} /> : state === 'failed' ? <WikiIcon name="failed" size={12} /> : null}</small> : null,
            ...(hasChildren && !matches ? { expanded, toggleLabel: `${expanded ? u('折叠', 'Collapse') : u('展开', 'Expand')} ${child.title}`, onToggle: () => setCollapsed(previous => { const next = new Set(previous); next.has(child.id) ? next.delete(child.id) : next.add(child.id); return next }) } : {})
          })
        }
        if (!collapsed.has(child.id) || matches || activePath.has(child.id)) collect(child, depth + (group ? 0 : 1), kids, seen)
      }
    }
    for (const node of treePages.filter(p => (p.parentId ?? null) === null).filter(p => !matches || visible.has(p.id))) {
      const kids: BranchedMenuChild[] = []
      collect(node, 1, kids, new Set([node.id]))
      const group = node.kind === 'group'
      if (group && !kids.length) continue
      const item = task?.items?.find(entry => entry.id === node.id)
      const savedState = item?.bodyState ?? (node.bytes ? 'complete' : item?.state ?? 'pending')
      const state = savedState === 'writing' && !task?.running ? 'pending' : savedState
      const pending = !group && !node.bytes
      const status = state === 'writing' ? u('生成中', 'Writing') : state === 'failed' ? u('失败', 'Failed') : u('待生成', 'Pending')
      const nodeState: BranchedMenuState = group
        ? (kids.some(kid => !kid.disabled) ? 'ready' : 'pending')
        : (pending ? (state === 'writing' ? 'writing' : state === 'failed' ? 'failed' : 'pending') : 'ready')
      const common = { id: node.id, label: node.title, title: pending ? `${node.title} · ${status}` : node.title, state: nodeState, disabled: pending, collapsible: !matches, badge: draftMode && pending ? <small className={`${state === 'failed' ? 'drw-node-warning' : ''}${state === 'writing' ? ' drw-node-loading' : ''}`} aria-hidden="true">{state === 'writing' ? <WikiIcon name="writing" size={12} /> : state === 'failed' ? <WikiIcon name="failed" size={12} /> : null}</small> : null }
      if (kids.length) items.push({ ...common, ...(group ? {} : { value: node.id }), children: kids })
      else if (!group) items.push({ ...common, value: node.id })
    }
    return items
  })()
  const openSections = menuItems.reduce<number[]>((list, item, index) => {
    if (!item.children?.length) return list
    if (!matches && item.id && collapsed.has(item.id) && !activePath.has(item.id)) return list
    list.push(index)
    return list
  }, [])
  const readable = wiki?.pages.filter(p => p.kind !== 'group' && p.bytes > 0) ?? []
  const routeList = routePages(wiki?.pages ?? [], wiki?.readingPaths, route)
  const breadcrumb: WikiPageMeta[] = []
  let ancestor = page
  const ancestors = new Set<string>()
  while (ancestor && !ancestors.has(ancestor.id)) { breadcrumb.unshift(ancestor); ancestors.add(ancestor.id); ancestor = wiki?.pages.find(p => p.id === ancestor?.parentId) }
  return <>
    <div className="drw-project-header"><header className="drw-panelhead"><div className="drw-panelhead-info"><Button variant="ghost" size="sm" aria-label={u('返回项目列表', 'Projects')} title={u('返回项目列表', 'Projects')} onClick={onBack}><WikiIcon name="arrow-left" /></Button><div title={project.path}><strong>{project.name}</strong></div></div><div className="drw-panelhead-actions"><Button variant="ghost" size="sm" className="drw-iconbtn" aria-label={u('生成配置', 'Generation settings')} title={u('生成配置', 'Generation settings')} onClick={() => setMode('manage')}><WikiIcon name="settings" /></Button></div></header>
    <div className="drw-project-tabs"><SegmentedControl id="drw-project-views" value={mode} onChange={v => setMode(v as typeof mode)} label={u('项目视图', 'Project view')} options={[{ value: 'read', label: 'Wiki' }, { value: 'cards', label: u('知识卡片', 'Cards') }, { value: 'manage', label: u('管理', 'Manage') }]} /></div>
    </div><div className="drw-workspace">
      <aside className="drw-directory" hidden={directoryHidden || mode === 'manage'}><Input type="search" aria-label={u('搜索 Wiki 页面', 'Search Wiki pages')} placeholder={u('搜索文档', 'Search documents')} value={query} onChange={e => setQuery(e.target.value)} disabled={!wiki} />
        <button type="button" className={`drw-tasklink ${mode === 'manage' ? 'active' : ''}`} onClick={() => setMode('manage')}><span className="drw-tasklink-label"><WikiIcon name="wiki" />{u('任务与设置', 'Tasks & Settings')}</span><small>{task ? <Stage status={task} /> : wiki ? u('已生成', 'Generated') : ''}</small></button>
        <div className="drw-bm-scroll">
          {wiki ? <BranchedMenu items={menuItems} open={openSections} active={mode === 'read' ? pageId : ''} onSelect={value => navigatePage(value)} onToggle={(index, nextOpen) => { const id = menuItems[index]?.id; if (!id) return; setCollapsed(previous => { const next = new Set(previous); if (nextOpen) next.delete(id); else next.add(id); return next }) }} labels={{ expand: u('展开', 'Expand'), collapse: u('折叠', 'Collapse') }} ariaLabel={t('contents')} /> : <div className="drw-directory-empty"><span className="drw-empty-mark"><WikiIcon name="wiki" size={48} /></span><p>{task?.running ? u('正在分析仓库 / 规划目录', 'Analyzing / planning outline') : u('尚未生成 Repo Wiki', 'No Repo Wiki yet')}</p></div>}
          {matches?.length === 0 && <p className="drw-muted">{u('没有匹配的页面', 'No matching pages')}</p>}
        </div>

      </aside>
      <section className="drw-reader-column">
        <div className="drw-reader-toolbar" hidden={mode === 'manage'}>
          <Button variant="ghost" size="sm" title={directoryHidden ? u('显示目录', 'Show contents') : u('收起目录', 'Hide contents')} aria-label={directoryHidden ? u('显示目录', 'Show contents') : u('收起目录', 'Hide contents')} onClick={() => setDirectoryHidden(value => { try { sessionStorage.setItem(`${positionKey}:directory`, value ? 'shown' : 'hidden') } catch {} return !value })}><WikiIcon name="list" /></Button>
          {mode === 'read' && <SegmentedControl id="drw-reader-tabs" value={readerTab} onChange={setReaderTab} label={u('阅读方式', 'Reader view')} options={[{ value: 'document', label: u('文档', 'Document') }, { value: 'markdown', label: 'Markdown' }, { value: 'sources', label: u('来源', 'Sources') }]} />}
        </div>
      <main className={`drw-main ${mode === 'read' ? 'drw-main-reading' : ''}`} ref={main} onScroll={e => { if (!scrollPosition.current.ready) return; scrollPosition.current.top = e.currentTarget.scrollTop; try { sessionStorage.setItem(scrollKey, String(e.currentTarget.scrollTop)) } catch { /* Optional storage. */ } }}>
        {error && <div className="drw-alert" role="alert">{error}</div>}{notice && <div className="drw-notice" role="status">{notice}</div>}
        {mode === 'manage' && <div className="drw-management drw-management-simple">
          <section className="drw-management-task" aria-label={u('生成任务', 'Generation')}>
        {(() => {
          const taskModel = models?.models.find(m => m.provider === task?.model?.provider && m.model === task?.model?.model)
          const taskModelLabel = taskModel?.name ?? taskModel?.label
          const isDraftRead = draftMode && task?.stage !== 'done'
          const canReadPublished = !isDraftRead && (readable.length > 0 || (project.wiki?.pages ?? 0) > 0)
          const retryUpdate = shouldRetryIncrementalLabel(config, task)
          const taskActions = (canReadPublished || (!task?.running && config?.git.available && project.wiki)) ? <>
            {canReadPublished && <Button variant={!task?.running && task?.recoverable ? 'outline' : 'primary'} onClick={() => setMode('read')}>{u('阅读 Wiki', 'Read Wiki')}</Button>}
            {!task?.running && config?.git.available && project.wiki && <Button variant="outline" disabled={busy} onClick={() => { void act(async () => { await call(remote.startGeneration({ path: project.path, mode: 'update' })); await refreshJobs(); await reload() }) }}>{retryUpdate ? u('重试增量更新', 'Retry incremental update') : u('增量更新', 'Incremental update')}</Button>}
          </> : null
          if (task) {
            return <Progress status={task} modelLabel={taskModelLabel} busy={busy} actions={taskActions} onPause={() => { void act(async () => { await call(remote.pauseJob({ jobId: task.jobId! })); await refreshJobs() }) }} onResume={() => { void act(async () => { await call(remote.resumeJob({ jobId: task.jobId! })); setDraftMode(true); await refreshJobs() }) }} onCancel={() => { void act(async () => { await call(remote.cancelJob({ jobId: task.jobId! })); await refreshJobs() }) }} />
          }
          if (project.wiki) {
            return <section className="drw-progress drw-task-summary">
              <div className="drw-task-header">
                <div className="drw-task-header-main">
                  <span className="drw-section-label">{u('当前任务', 'Current task')}</span>
                  <div className="drw-task-headline">
                    <StatusMark status="done" size={22} strokeWidth={2} strike={false} labels={{ done: u('已生成', 'Generated') }} />
                    <h2><span className="drw-jobstage drw-job-done">{u('已生成', 'Generated')}</span></h2>
                  </div>
                </div>
                {taskActions && <div className="drw-actions drw-task-actions">{taskActions}</div>}
              </div>
              <p className="drw-muted drw-task-count">
                {project.wiki.pages} {u('页已生成', 'pages')}{!!project.wiki.cards && ` · ${project.wiki.cards} ${u('张知识卡片', 'cards')}`}
                {project.wiki.updatedAt && ` · ${u('更新于', 'Updated')} ${new Date(project.wiki.updatedAt).toLocaleString()}`}
              </p>
            </section>
          }
          return <section className="drw-progress drw-task-summary">
            <span className="drw-section-label">{u('当前任务', 'Current task')}</span>
            <div className="drw-task-headline">
              <StatusMark status="pending" size={22} strokeWidth={2} strike={false} labels={{ pending: u('尚未生成', 'Not generated') }} />
              <h2><span className="drw-jobstage">{u('尚未生成', 'Not generated')}</span></h2>
            </div>
            <p className="drw-muted drw-task-count">{u('请在下方确认生成设置并点击「开始生成」。', 'Review generation settings below and click Generate.')}</p>
          </section>
        })()}
          </section>
          <section className="drw-management-settings">
        {config ? <Configuration config={config} models={models} busy={busy} running={!!task?.running} project={project} wiki={wiki} remote={remote} onToggleSwitch={toggleSwitch} onReloadModels={() => { void act(async () => { setModels(await call(remote.getModelCapabilities(AbortSignal.timeout(20000)))) }) }} onSave={(settings, start) => { void act(async () => {
          const latest = configRef.current?.settings
          const merged = latest ? { ...settings, autoUpdate: latest.autoUpdate, autoExport: latest.autoExport, agentReference: latest.agentReference } : settings
          const c = await call(remote.saveProjectConfig({ path: project.path, settings: merged })); configRef.current = c; setConfig(c)
          if (start) { await call(remote.startGeneration({ path: project.path })); await refreshJobs(); setMode('manage') }
          else setNotice(u('配置已保存。', 'Settings saved.'))
        }) }} /> : <p className="drw-muted">{u('正在读取配置和模型…', 'Loading settings and models…')}</p>}
          </section>
        </div>}
        {mode === 'cards' && wiki && <Knowledge wiki={wiki} draft={draftMode} u={u} onSource={openSource} />}
        {(mode === 'read' || mode === 'cards') && !wiki && <p className="drw-muted">{u('尚未生成内容，请在生成配置中开始。', 'No content yet. Start from settings.')}</p>}
        {mode === 'read' && wiki && !pageId && <p className="drw-muted">{u('请选择已完成的页面。', 'Choose a completed page.')}</p>}
        {mode === 'read' && wiki && pageId && <>
          {route !== 'all' && wiki.readingPaths && <nav className="drw-route-list" aria-label={u('推荐阅读顺序', 'Recommended reading order')}>{routeList.length ? routeList.map((p, index) => <Button key={p.id} variant="ghost" size="sm" aria-current={p.id === pageId ? 'page' : undefined} onClick={() => navigatePage(p.id)}>{index + 1}. {p.title}</Button>) : <p>{u('当前项目暂无对应阅读路线', 'No reading path is available for this project')}</p>}</nav>}
          <div className={`drw-article-layout ${readerTab !== 'document' ? 'drw-article-layout-wide' : ''}`}><div className="drw-article-content">
          {breadcrumb.length > 1 && <nav className="drw-breadcrumb" aria-label={u('页面位置', 'Breadcrumb')}>{breadcrumb.slice(0, -1).map(p => <span key={p.id}>{p.title}</span>)}</nav>}
          {readerTab === 'markdown' && <pre className="drw-raw-markdown">{body}</pre>}
          {readerTab === 'document' && <h1 className="drw-reading-title">{page?.title}</h1>}
          {draftMode && readerTab === 'document' && (() => {
            const item = task?.items?.find(entry => entry.id === pageId)
            const writing = task?.running && item?.bodyState === 'writing'
            const reviewing = task?.running && item?.step === 'verify' && task.currentAction === `核验 ${page?.title}`
            const label = writing ? (task.currentAction?.startsWith('修订 ') ? u('修订中', 'Revising') : u('生成中', 'Writing'))
              : reviewing ? u('核验中', 'Reviewing')
              : item?.verificationState === 'uncertain' ? u('待修订', 'Needs revision') : ''
            return label ? <small className="drw-muted" role="status">{label}</small> : null
          })()}

          {readerTab === 'document' && !!references.length && <details className="drw-reference-files"><summary>{u('参考文件', 'Referenced files')} ({references.length})</summary><div>{references.map(source => <Button key={source.path} variant="ghost" size="sm" title={source.path} onClick={event => { citationOrigin.current = event.currentTarget; void openSource(source.id, source.startLine) }}>{sourceLabel(source.path, sourcePaths)}</Button>)}</div></details>}

          <article hidden={readerTab !== 'document'} ref={article} className="drw-document"><MarkdownDelegateProvider openFile={revealFile}><MermaidMarkdown text={reading.text} labels={labels} fileMentions={{ resolve: visibleValue => {
            const value = reading.originals.get(visibleValue) ?? visibleValue
            const path = value.replace(/:(?:L)?\d+(?:-L?\d+)?$/, '')
            return page?.sources?.some(s => s.path === path) ? { open: () => revealFile(value), label: sourceLabel(path, sourcePaths) + (value.match(/:L?\d+(?:-L?\d+)?$/)?.[0] ?? ''), title: `${u('查看引用', 'View source')}: ${value}` } : undefined
          } }} /></MarkdownDelegateProvider></article>
          {readerTab === 'sources' && <>
            <section ref={sourceTarget} className="drw-source-view">
              <Button variant="ghost" size="sm" onClick={returnToCitation}>{u('返回正文', 'Back to document')}</Button>
              {sourceLoading && <p role="status">{u('正在读取引用…', 'Loading source…')}</p>}
              {!sourceLoading && sourceRetry && <Button onClick={() => { void openSource(sourceRetry.id, sourceRetry.line) }}>{u('重试读取引用', 'Retry source')}</Button>}
              {source && <><strong>{source.path}</strong><p className="drw-muted">{source.version} · {source.hash.slice(0, 12)}</p><SourceView source={source} line={sourceLine} onLine={setSourceLine} u={u} /></>}
            </section>
            <details key={source?.id ?? 'all-sources'} open={!source && !sourceLoading} className="drw-sources"><summary>{u('本页来源', 'Page sources')} ({page?.sources?.length ?? 0})</summary><div className="drw-actions">{page?.sources?.map(s => <Button key={s.id} variant="outline" size="sm" onClick={() => { void openSource(s.id, s.startLine) }}>{s.path}:{s.startLine}–{s.endLine}</Button>)}</div></details>
          </>}
          {readerTab === 'document' && (() => {
            const childPages = wiki.pages.filter(entry => entry.parentId === page?.id && entry.kind !== 'group')
            if (!childPages.length) return null
            return <section className="drw-child-pages" aria-label={u('下属页面', 'Child pages')}>
              <h2>{u('本分类页面', 'In this section')}</h2>
              <div className="drw-child-grid">{childPages.map(child => <button key={child.id} type="button" className="drw-child-card" disabled={!child.bytes} onClick={() => navigatePage(child.id)}><strong>{child.title}</strong>{child.summary && <span>{child.summary}</span>}</button>)}</div>
            </section>
          })()}
          {!!page?.relatedPageIds?.length && <nav className="drw-related-pages" aria-label={u('继续阅读', 'Related pages')}>{page.relatedPageIds.map(id => { const related = wiki.pages.find(p => p.id === id && p.kind !== 'group'); return related ? <Button key={id} variant="ghost" disabled={!related.bytes} onClick={() => navigatePage(id)}>{related.title}</Button> : <small key={id}>{u('关联页面不存在', 'Related page is unavailable')}</small> })}</nav>}
          <div className="drw-pager">{[-1, 1].map(delta => { const adjacent = (route === 'all' || !wiki.readingPaths ? readable : routeList)[(route === 'all' || !wiki.readingPaths ? readable : routeList).findIndex(p => p.id === pageId) + delta]; return <Button key={delta} variant="ghost" disabled={!adjacent} onClick={() => adjacent && navigatePage(adjacent.id)}>{delta < 0 && <WikiIcon name="arrow-left" />}{adjacent?.title ?? (delta < 0 ? t('prev') : t('next'))}{delta > 0 && <WikiIcon name="arrow-right" />}</Button> })}</div>
          </div>
          {readerTab === 'document' && headings.length > 1 && <details open={wideOutline} className="drw-page-outline"><summary>{u('本页目录', 'On this page')}</summary><nav className="drw-outline" aria-label={u('文内导航', 'On this page')}>{headings.map(h => <button type="button" className={h.level === 3 ? 'drw-outline-child' : undefined} key={h.id} onClick={() => article.current?.querySelector(`#${h.id}`)?.scrollIntoView({ block: 'start' })}>{h.text}</button>)}</nav></details>}
          </div>
        </>}
      </main>
      </section>
    </div>
  </>
}

export function RepoWikiPage({ ctx }: { ctx: PanelContext }): ReactElement {
  const [remote] = useState(() => ctx.remote.repowiki)
  const u = useText(), jobState = useJobs()
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [path, setPath] = useState(rememberedPath)
  const [filter, setFilter] = useState<'all' | 'done' | 'none'>('all')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const latestRequest = useRef(0)
  const reload = useCallback(async () => { const n = ++latestRequest.current; try {
    const response = await call(remote.listProjects()); if (n === latestRequest.current) { setProjects(response.projects); setError('') }
  } catch (e) { if (n === latestRequest.current) setError(message(e)) } finally { if (n === latestRequest.current) setLoading(false) } }, [remote])
  const completed = jobState.jobs.map(j => `${j.jobId}:${j.finishedAt}`).join('|')
  useEffect(() => { void reload(); return () => { latestRequest.current++ } }, [reload, completed])
  const open = (newPath: string) => { remember(newPath); setPath(newPath) }
  const entries = projects.map(p => ({ ...p, task: jobState.jobs.find(j => j.repoPath === p.path) ?? p.task }))
  const current = entries.find(p => p.path === path)
  return <div className="drw-root">
    {jobState.error && <div className="drw-notice">{u('进度连接暂时中断，正在重连；后台任务不会因此取消。', 'Progress connection interrupted. Reconnecting; background tasks continue.')}</div>}
    {error && <div role="alert" className="drw-alert">{error}<Button variant="ghost" onClick={() => { void reload() }}>{t('retry')}</Button></div>}
    {current ? <Detail key={current.path} remote={remote} project={current} task={jobState.jobs.find(j => j.repoPath === current.path)} onBack={() => { open(''); void reload() }} reload={reload} />
      : <div className="drw-page">{loading ? <p>{u('正在读取项目…', 'Loading projects…')}</p> : <ListPage projects={entries} filter={filter} viewMode={viewMode} busy={null} onFilter={setFilter} onViewMode={setViewMode} onOpen={i => { if (entries[i]) open(entries[i]!.path) }} onGenerate={i => { if (entries[i]) open(entries[i]!.path) }} />}</div>}
  </div>
}
