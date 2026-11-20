/**
 * StatusMark、ThoughtLine 与任务轨迹映射的自动化测试。
 * 沿用 test/branched-menu.test.ts 的 esbuild + react-dom/server 无 DOM 模式。
 */
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Plugin } from 'esbuild'
import { modelDisplay } from '../src/shared/models.js'
import type { GenerationStatus, ProjectConfiguration, ProjectSettings } from '../src/shared/types.js'
import {
  buildTaskTrace,
  formatTaskDeciseconds,
  generationSettingsEqual,
  shouldRetryIncrementalLabel,
  statusToMark,
} from '../src/client/task-trace.js'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
const esbuild = require('esbuild') as typeof import('esbuild')

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const statusBundlePath = join(here, `.status-mark.test.${process.pid}.mjs`)
const thoughtBundlePath = join(here, `.thought-line.test.${process.pid}.mjs`)

const stubHostPrimitives: Plugin = {
  name: 'stub-host-ui-primitives',
  setup(api) {
    api.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({
      path: 'host-ui-primitives-stub',
      namespace: 'task-components-test',
    }))
    api.onLoad({ filter: /.*/, namespace: 'task-components-test' }, () => ({
      contents: `import { createElement } from 'react'
const icon = name => props => createElement('svg', { 'data-icon': name, width: (props && props.size) || 16, height: (props && props.size) || 16, 'aria-hidden': 'true' })
export const IconCheckOutlineRegular = icon('check')
export const IconDeliverDocRegular = icon('document')
export const IconCodeOutlineRegular = icon('code')
export const IconPanelLeftOutlineRegular = icon('panel')
export const IconCopyOutlineRegular = icon('cards')
export const IconFlatListOutlineRegular = icon('list')
export const IconChevronDownOutlineRegular = icon('chevron-down')
export const IconChevronRightOutlineRegular = icon('chevron-right')
export const IconLoadingOutlineRegular = icon('writing')
export const IconSettingsOutlineRegular = icon('settings')
export const IconSparkleRegular = icon('sparkle')
export const IconWarningTriangleOutlineRegular = icon('failed')
`,
      loader: 'js',
      resolveDir: root,
    }))
  },
}

let statusModule: Promise<{ StatusMark: (props: Record<string, unknown>) => unknown }> | undefined
let thoughtModule: Promise<{ ThoughtLine: (props: Record<string, unknown>) => unknown }> | undefined

async function loadStatusMark() {
  statusModule ??= (async () => {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [join(root, 'src/client/status-mark.tsx')],
      outfile: statusBundlePath,
      bundle: true,
      write: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime'],
      plugins: [stubHostPrimitives],
      logLevel: 'silent',
    })
    return await import(pathToFileURL(statusBundlePath).href)
  })()
  return statusModule
}

async function loadThoughtLine() {
  thoughtModule ??= (async () => {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [join(root, 'src/client/thought-line.tsx')],
      outfile: thoughtBundlePath,
      bundle: true,
      write: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime'],
      plugins: [stubHostPrimitives],
      logLevel: 'silent',
    })
    return await import(pathToFileURL(thoughtBundlePath).href)
  })()
  return thoughtModule
}

async function renderQuiet(renderFn: () => string): Promise<string> {
  const original = console.error
  console.error = (...args: unknown[]) => {
    if (String(args[0] ?? '').includes('useLayoutEffect does nothing on the server')) return
    original(...(args as []))
  }
  try {
    return renderFn()
  } finally {
    console.error = original
  }
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
}

const baseStatus = (overrides: Partial<GenerationStatus> = {}): GenerationStatus => ({
  running: false,
  stage: 'idle',
  wikiId: 'wiki-1',
  repoPath: '/repo',
  pagesDone: 0,
  pagesTotal: 0,
  error: null,
  result: null,
  ...overrides,
})

const baseSettings = (overrides: Partial<ProjectSettings> = {}): ProjectSettings => ({
  language: 'zh',
  model: null,
  maxPages: 32,
  autoUpdate: false,
  autoExport: false,
  agentReference: true,
  collaboration: 'collaborative',
  concurrency: 2,
  granularity: 'standard',
  roles: {},
  exclude: [],
  ...overrides,
})

test('StatusMark：渲染五种状态、几何 dasharray 与无障碍标签', async () => {
  const { StatusMark } = await loadStatusMark()
  const renderMark = (props: Record<string, unknown>) =>
    renderQuiet(() => renderToStaticMarkup(React.createElement(StatusMark as never, props as never)))

  const pending = await renderMark({ status: 'pending' })
  assert.match(pending, /class="drw-sm"/)
  assert.match(pending, /data-status="pending"/)
  assert.match(pending, /data-strike=""/)
  assert.match(pending, /role="img"/)
  assert.match(pending, /aria-label="Pending"/)
  const pendingRing = /<circle[^>]*class="drw-sm__ring"[^>]*>/.exec(pending)?.[0] ?? ''
  const [pDash, pGap] = (attr(pendingRing, 'stroke-dasharray') ?? '').split(' ').map(Number)
  const r = 10 - 2 / 2
  const C = 2 * Math.PI * r
  const P = C / 8
  assert.ok(Math.abs((pDash ?? 0) - 0.3 * P) < 0.01)
  assert.ok(Math.abs((pGap ?? 0) - 0.7 * P) < 0.01)

  const indeterminate = await renderMark({ status: 'running' })
  assert.match(indeterminate, /data-status="running"/)
  assert.match(indeterminate, /data-indeterminate=""/)
  const indRing = /<circle[^>]*class="drw-sm__ring"[^>]*>/.exec(indeterminate)?.[0] ?? ''
  const [iDash, iGap] = (attr(indRing, 'stroke-dasharray') ?? '').split(' ').map(Number)
  assert.ok(Math.abs((iDash ?? 0) - 0.68 * C) < 0.05)
  assert.ok(Math.abs((iGap ?? 0) - 0.32 * C) < 0.05)

  const determinate = await renderMark({
    status: 'running',
    progress: 0.62,
    labels: { running: '生成中' },
  })
  assert.equal(/data-indeterminate/.test(determinate), false)
  assert.match(determinate, /aria-label="生成中, 62%"/)
  const detRing = /<circle[^>]*class="drw-sm__ring"[^>]*>/.exec(determinate)?.[0] ?? ''
  const [dDash, dGap] = (attr(detRing, 'stroke-dasharray') ?? '').split(' ').map(Number)
  assert.ok(Math.abs((dDash ?? 0) - 0.62 * C) < 0.05)
  assert.ok(Math.abs((dGap ?? 0) - 0.38 * C) < 0.05)

  const done = await renderMark({
    status: 'done',
    label: '生成文档',
    labels: { done: '已完成' },
  })
  assert.match(done, /data-status="done"/)
  assert.match(done, /class="drw-sm__sr">已完成: <\/span>/)
  assert.match(done, /class="drw-sm__label">生成文档<span class="drw-sm__strike"/)
  assert.match(done, /class="drw-sm__glyph"[^>]*aria-hidden="true"/)

  const failed = await renderMark({ status: 'failed', strike: false })
  assert.match(failed, /data-status="failed"/)
  assert.equal(/data-strike/.test(failed), false)

  const cancelled = await renderMark({ status: 'cancelled' })
  assert.match(cancelled, /data-status="cancelled"/)
})

test('ThoughtLine：运行态自动展开并微光扫描，完成态默认折叠且格式化耗时', async () => {
  const { ThoughtLine } = await loadThoughtLine()
  const renderThought = (props: Record<string, unknown>) =>
    renderQuiet(() => renderToStaticMarkup(React.createElement(ThoughtLine as never, props as never)))

  const workingHtml = await renderThought({
    working: true,
    label: '撰写 架构概览',
    steps: ['扫描源码并分析结构', '规划目录大纲 · 26 页', '撰写 架构概览'],
    elapsed: 45,
    formatTime: formatTaskDeciseconds,
  })
  assert.match(workingHtml, /data-working=""/)
  assert.match(workingHtml, /data-open=""/)
  assert.match(workingHtml, /data-shimmer=""/)
  assert.equal(/--tl-color:currentColor/.test(workingHtml), false, '默认不应写出 --tl-color:currentColor 破坏 shimmer')
  assert.match(workingHtml, /class="drw-tl__panel"/)
  assert.equal(/class="drw-tl__panel"[^>]*data-split/.test(workingHtml), false, '仅有 steps 时不应启用双栏')
  assert.match(workingHtml, /aria-expanded="true"/)
  assert.match(workingHtml, /data-icon="sparkle"/)
  assert.match(workingHtml, />45s<\/span>/)
  assert.equal((workingHtml.match(/class="drw-tl__step" data-done=""/g) ?? []).length, 2, '前两步应勾选')
  assert.equal((workingHtml.match(/class="drw-tl__pulse"/g) ?? []).length, 1, '最后一步应显示脉冲点')

  const settledHtml = await renderThought({
    working: false,
    doneLabel: '生成完成 · 用时',
    steps: ['扫描源码并分析结构', '保存并发布 Wiki 版本'],
    elapsed: 1784,
    formatTime: formatTaskDeciseconds,
    collapseOnSettle: true,
    footer: React.createElement('div', { className: 'drw-task-meta' }, 'DeepSeek-V4.1-Flash'),
  })
  assert.equal(/data-working/.test(settledHtml), false)
  assert.equal(/data-open/.test(settledHtml), false, '已完成任务首帧应直接折叠')
  assert.match(settledHtml, /aria-expanded="false"/)
  assert.match(settledHtml, />29m 44s<\/span>/)
  assert.match(settledHtml, /class="drw-tl__panel" data-split=""/, '同时存在 steps 与 footer 时应启用双栏布局')
  assert.equal((settledHtml.match(/class="drw-tl__step" data-done=""/g) ?? []).length, 2)
  assert.match(settledHtml, /class="drw-tl__footer"><div class="drw-task-meta">DeepSeek-V4\.1-Flash<\/div>/)

  const dotHtml = await renderThought({
    working: true,
    glyph: 'dot',
    steps: [],
    footer: React.createElement('p', null, '元信息'),
  })
  assert.match(dotHtml, /class="drw-tl__dot"/)
  assert.equal(/class="drw-tl__panel"[^>]*data-split/.test(dotHtml), false, '仅有 footer 时不应启用双栏')
  assert.match(dotHtml, /class="drw-tl__chevron" data-on=""/, '仅有 footer 时也应支持展开')
})

test('task-trace：状态映射、阶段轨迹、重试文案与脏状态比较', () => {
  const u = (zh: string, en: string) => zh || en

  assert.deepEqual(statusToMark(baseStatus({ running: true, stage: 'queued' })), { status: 'running' })
  assert.deepEqual(statusToMark(baseStatus({ running: true, stage: 'plan' })), { status: 'running' })
  assert.deepEqual(statusToMark(baseStatus({ running: true, stage: 'pages', pagesDone: 0, pagesTotal: 0 })), { status: 'running' })
  const mid = statusToMark(baseStatus({ running: true, stage: 'pages', pagesDone: 13, pagesTotal: 26 }))
  assert.equal(mid.status, 'running')
  assert.ok(mid.progress && Math.abs(mid.progress - 13 / 27) < 0.001)
  const cap = statusToMark(baseStatus({ running: true, stage: 'export', pagesDone: 26, pagesTotal: 26, result: { wikiId: 'w', title: 't', pageCount: 26, refs: 1 } }))
  assert.equal(cap.progress, 0.99)
  assert.deepEqual(statusToMark(baseStatus({ stage: 'done' })), { status: 'done' })
  assert.deepEqual(statusToMark(baseStatus({ stage: 'failed' })), { status: 'failed' })
  assert.deepEqual(statusToMark(baseStatus({ stage: 'partial' })), { status: 'failed' })
  assert.deepEqual(statusToMark(baseStatus({ stage: 'cancelled' })), { status: 'cancelled' })
  assert.deepEqual(statusToMark(baseStatus({ stage: 'paused' })), { status: 'pending' })
  assert.deepEqual(statusToMark(baseStatus({ stage: 'interrupted' })), { status: 'pending' })

  assert.equal(formatTaskDeciseconds(0), '0s')
  assert.equal(formatTaskDeciseconds(599), '59s')
  assert.equal(formatTaskDeciseconds(600), '1m 0s')
  assert.equal(formatTaskDeciseconds(17840), '29m 44s')
  assert.equal(formatTaskDeciseconds(36600), '1h 01m')

  const doneTrace = buildTaskTrace(
    baseStatus({ stage: 'done', pagesDone: 26, pagesTotal: 26, cardsDone: 8, verifiedDone: 26 }),
    u,
  )
  assert.equal(doneTrace.doneLabel, '生成完成 · 用时')
  assert.deepEqual(doneTrace.steps, [
    '扫描并规划目录 · 26 页',
    '生成 26 / 26 页 · 8 张卡片',
  ])

  const runningVerifyTrace = buildTaskTrace(
    baseStatus({
      running: true,
      stage: 'verify',
      pagesDone: 5,
      pagesTotal: 31,
      verifiedDone: 5,
      currentAction: '核验 在对话中查询用量',
    }),
    u,
  )
  assert.deepEqual(runningVerifyTrace.steps, [
    '扫描并规划目录 · 31 页',
    '核验 在对话中查询用量',
  ])

  const reusedTrace = buildTaskTrace(
    baseStatus({ stage: 'done', currentAction: '源码未变化，已复用正式版本' }),
    u,
  )
  assert.deepEqual(reusedTrace.steps, ['检测源码快照', '源码未变化，已复用正式版本'])

  const retryTrace = buildTaskTrace(
    baseStatus({
      running: true,
      stage: 'pages',
      pagesDone: 2,
      pagesTotal: 10,
      waiting: { reason: '429', attempt: 2, retryAt: new Date().toISOString(), code: 'rate_limit' },
    }),
    u,
  )
  assert.equal(retryTrace.label, '等待重试 (2/3)')

  const cfg: ProjectConfiguration = {
    path: '/repo',
    settings: baseSettings(),
    canGenerate: true,
    reason: null,
    git: { available: true, branch: 'main', commit: 'abc' },
    updateNotice: null,
  }
  assert.equal(shouldRetryIncrementalLabel(cfg, baseStatus({ stage: 'done' })), false)
  assert.equal(shouldRetryIncrementalLabel({ ...cfg, updateNotice: '更新失败' }, baseStatus({ stage: 'done' })), true)
  assert.equal(shouldRetryIncrementalLabel(cfg, baseStatus({ stage: 'failed' })), true)
  assert.equal(shouldRetryIncrementalLabel(cfg, baseStatus({ stage: 'partial' })), true)

  const a = baseSettings()
  const b = baseSettings({ autoUpdate: true, autoExport: true, agentReference: false })
  assert.equal(generationSettingsEqual(a, b), true, '即点即存开关变化不应触发生成参数 dirty')
  assert.equal(generationSettingsEqual(a, baseSettings({ granularity: 'deep' })), false)
  assert.equal(generationSettingsEqual(a, baseSettings({ language: 'en' })), false)
  assert.equal(generationSettingsEqual(a, baseSettings({ model: { provider: 'p', model: 'm' } })), false)
})

test('modelDisplay：剥离 routing group 副标签，保留纯净模型名', () => {
  assert.deepEqual(modelDisplay('Connect Router', 'DeepSeek-V4.1-Flash · routing group'), {
    name: 'DeepSeek-V4.1-Flash',
    source: 'Connect Router',
    description: 'routing group',
  })
})

after(async () => {
  await Promise.all([
    rm(statusBundlePath, { force: true }),
    rm(thoughtBundlePath, { force: true }),
  ])
})
