import type { GenerationStatus, ModelSelection, ProjectConfiguration, ProjectSettings } from '../shared/types.js'
import type { StatusMarkStatus } from './status-mark.js'

export type TextFn = (zh: string, en: string) => string

const DETERMINATE_STAGES = new Set<GenerationStatus['stage']>(['pages', 'cards', 'verify', 'write', 'export'])
const TERMINAL_INCOMPLETE = new Set<GenerationStatus['stage']>(['failed', 'partial', 'paused', 'interrupted', 'cancelled'])

/** 把宿主任意 GenerationStatus 映射为 StatusMark 所需的原位形变状态与定量进度。 */
export function statusToMark(status: GenerationStatus): { status: StatusMarkStatus; progress?: number } {
  if (status.running) {
    if (status.pagesTotal > 0 && DETERMINATE_STAGES.has(status.stage)) {
      const raw = (status.pagesDone + (status.result ? 1 : 0)) / (status.pagesTotal + 1)
      return { status: 'running', progress: Math.min(0.99, Math.max(0.05, raw)) }
    }
    return { status: 'running' }
  }
  if (status.stage === 'done') return { status: 'done' }
  if (status.stage === 'failed' || status.stage === 'partial') return { status: 'failed' }
  if (status.stage === 'cancelled') return { status: 'cancelled' }
  return { status: 'pending' }
}

/** 将分秒（deciseconds）格式化为适合任务耗时的紧凑文本（s / m s / h m）。 */
export function formatTaskDeciseconds(ds: number): string {
  const totalSec = Math.max(0, Math.floor(ds / 10))
  if (totalSec < 60) return `${totalSec}s`
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`
  const hours = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  return `${hours}h ${String(mins).padStart(2, '0')}m`
}

/** 结合阶段、计数与实时动作构造 ThoughtLine 所需的标题与阶段轨迹。 */
export function buildTaskTrace(
  status: GenerationStatus,
  u: TextFn,
): { label: string; doneLabel: string; steps: string[] } {
  const steps: string[] = []
  const stage = status.stage

  if (stage === 'queued' && !status.pagesTotal && !status.cardsDone) {
    steps.push(u('等待任务队列调度', 'Waiting in task queue'))
  } else if (stage !== 'idle') {
    if (!status.running && status.currentAction === '源码未变化，已复用正式版本') {
      steps.push(
        u('检测源码快照', 'Checking source snapshot'),
        u('源码未变化，已复用正式版本', 'Source unchanged; reused published Wiki'),
      )
    } else {
      if (status.pagesTotal > 0) {
        steps.push(u(`扫描并规划目录 · ${status.pagesTotal} 页`, `Scanned & planned · ${status.pagesTotal} pages`))
      } else if (stage === 'plan') {
        steps.push(u('扫描源码并规划目录', 'Scanning & planning outline'))
      } else {
        steps.push(u('扫描源码并分析结构', 'Scanning & analyzing repository'))
      }

      const reachedProgress =
        ['pages', 'cards', 'verify', 'write', 'export', 'done'].includes(stage)
        || status.pagesDone > 0
        || !!status.cardsDone
        || !!status.verifiedDone
        || (status.pagesTotal > 0 && TERMINAL_INCOMPLETE.has(stage))

      const formatProgress = () => {
        const parts: string[] = [
          status.pagesTotal
            ? u(`生成 ${status.pagesDone} / ${status.pagesTotal} 页`, `Pages ${status.pagesDone} / ${status.pagesTotal}`)
            : u('撰写文档页面', 'Writing pages'),
        ]
        if (status.cardsDone) parts.push(u(`${status.cardsDone} 张卡片`, `${status.cardsDone} cards`))
        else if (status.verifiedDone) parts.push(u(`核验 ${status.verifiedDone} 项`, `Verified ${status.verifiedDone}`))
        return parts.join(' · ')
      }

      if (status.running) {
        if (stage === 'export') steps.push(u('导出 Markdown 文件', 'Exporting Markdown files'))
        else if (stage === 'write') steps.push(u('保存并发布 Wiki 版本', 'Saving & publishing Wiki'))
        else if (status.currentAction && status.currentAction !== steps[0]) steps.push(status.currentAction)
        else if (reachedProgress) steps.push(formatProgress())
      } else if (reachedProgress) {
        steps.push(formatProgress())
      } else if (['write', 'export', 'done'].includes(stage) || !!status.result) {
        steps.push(u('保存并发布 Wiki 版本', 'Saved & published Wiki'))
      }
    }
  }

  let label: string
  if (status.waiting) {
    label = u(`等待重试 (${status.waiting.attempt}/3)`, `Retrying (${status.waiting.attempt}/3)`)
  } else if (status.currentAction) {
    label = status.currentAction
  } else if (stage === 'queued') {
    label = u('正在排队准备生成…', 'Queued for generation…')
  } else if (stage === 'pages' && status.pagesTotal) {
    label = u(
      `正在生成 · ${status.pagesDone} / ${status.pagesTotal} 页`,
      `Generating · ${status.pagesDone} / ${status.pagesTotal} pages`,
    )
  } else {
    label = u('正在生成 Wiki…', 'Generating Wiki…')
  }

  const doneLabel = stage === 'done'
    ? u('生成完成 · 用时', 'Completed ·')
    : stage === 'failed' || stage === 'partial'
    ? u('任务中止 · 用时', 'Stopped ·')
    : stage === 'paused' || stage === 'interrupted'
    ? u('已暂停 · 已用时', 'Paused ·')
    : stage === 'cancelled'
    ? u('已取消 · 用时', 'Cancelled ·')
    : u('尚未开始', 'Not started')

  return { label, doneLabel, steps }
}

/** 仅在存在更新失败提示或上次任务失败/部分失败时展示“重试增量更新”。 */
export function shouldRetryIncrementalLabel(
  config: ProjectConfiguration | null,
  task?: GenerationStatus,
): boolean {
  return Boolean(config?.updateNotice) || task?.stage === 'failed' || task?.stage === 'partial'
}

function normalizeModel(model?: ModelSelection | null): { provider: string; model: string; reasoningEffort: string } | null {
  if (!model) return null
  return {
    provider: model.provider,
    model: model.model,
    reasoningEffort: model.reasoningEffort ?? '',
  }
}

/** 序列化需经“保存设置”显式提交的生成参数（排除即点即存开关）。 */
export function generationSettingsKey(settings: ProjectSettings): string {
  return JSON.stringify({
    language: settings.language,
    granularity: settings.granularity ?? 'standard',
    model: normalizeModel(settings.model),
    maxPages: settings.maxPages,
    collaboration: settings.collaboration ?? 'collaborative',
    concurrency: settings.concurrency ?? 2,
    roles: {
      planner: normalizeModel(settings.roles?.planner),
      writer: normalizeModel(settings.roles?.writer),
      verifier: normalizeModel(settings.roles?.verifier),
    },
    exclude: settings.exclude ?? [],
  })
}

export function generationSettingsEqual(a: ProjectSettings, b: ProjectSettings): boolean {
  return generationSettingsKey(a) === generationSettingsKey(b)
}
