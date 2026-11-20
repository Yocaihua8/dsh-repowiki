/**
 * BranchedMenu（分支线目录）的最小自动测试。
 *
 * 现有测试环境是 node:test + tsx，没有 jsdom / @testing-library / react-test-renderer，
 * 因此按项目已有设施做无 DOM 验证：
 * - 用项目 devDependency 的 esbuild（与 scripts/build.mjs 同款）把 TSX 组件打成临时 ESM bundle；
 * - 用 react-dom/server 的 renderToStaticMarkup 渲染真实组件树；
 * - 宿主图标包（@deepseek-ai/dsh-client-ui-primitives）在 Node 下不可直接加载（CSS module 依赖），
 *   测试里用等价的轻量 stub 替换；断言只关注菜单自身的结构、选中、折叠与数据映射。
 */
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Plugin } from 'esbuild'
import type { BranchedMenuItem } from '../src/client/branched-menu.js'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
const esbuild = require('esbuild') as typeof import('esbuild')

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundlePath = join(here, `.branched-menu.test.${process.pid}.mjs`)

/** 宿主图标包的替代实现：只保留 WikiIcon 需要的图标组件形状。 */
const stubHostPrimitives: Plugin = {
  name: 'stub-host-ui-primitives',
  setup(api) {
    api.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'host-ui-primitives-stub', namespace: 'branched-menu-test' }))
    api.onLoad({ filter: /.*/, namespace: 'branched-menu-test' }, () => ({
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
      resolveDir: root
    }))
  }
}

let menuModule: Promise<{ BranchedMenu: (props: Record<string, unknown>) => unknown }> | undefined

/** 打包并以 ESM 方式载入组件（仅在首个测试用到时构建一次）。 */
function loadMenu(): Promise<{ BranchedMenu: (props: Record<string, unknown>) => unknown }> {
  menuModule ??= (async () => {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [join(root, 'src/client/branched-menu.tsx')],
      outfile: bundlePath,
      bundle: true,
      write: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      jsx: 'automatic',
      loader: { '.css': 'text' },
      external: ['react', 'react/jsx-runtime'],
      plugins: [stubHostPrimitives],
      logLevel: 'silent'
    })
    return await import(pathToFileURL(bundlePath).href)
  })()
  return menuModule
}

/** 渲染为静态 HTML；忽略 useLayoutEffect 在服务端渲染时的既有警告。 */
async function render(items: BranchedMenuItem[], props: Record<string, unknown> = {}): Promise<string> {
  const { BranchedMenu } = await loadMenu()
  const original = console.error
  console.error = (...args: unknown[]) => {
    if (String(args[0] ?? '').includes('useLayoutEffect does nothing on the server')) return
    original(...(args as []))
  }
  try {
    return renderToStaticMarkup(React.createElement(BranchedMenu as never, { items, ...props } as never))
  } finally {
    console.error = original
  }
}

/** 取出指定标签且 class 精确匹配的元素起始标签，便于逐项断言属性。 */
function tags(html: string, tag: string, className: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\bclass="${className}"[^>]*>`, 'g'))].map(match => match[0] ?? '')
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
}

const badge = React.createElement('small', { className: 'drw-node-loading', 'aria-hidden': 'true' }, '…')

const items: BranchedMenuItem[] = [
  {
    id: 'guide',
    label: '指南',
    children: [
      { value: 'install', label: '安装', depth: 1, title: '安装 · 待生成', disabled: true },
      { value: 'usage', label: '使用', depth: 2, badge }
    ]
  },
  { id: 'api', label: 'API', value: 'api' }
]

test('渲染：分组、子页行与标题/徽标/禁用状态按数据映射输出', async () => {
  const html = await render(items, { ariaLabel: '目录' })

  assert.equal(tags(html, 'nav', 'drw-bm').length, 1)
  assert.match(html, /^<nav class="drw-bm" aria-label="目录"/)
  assert.equal(tags(html, 'div', 'drw-bm__section').length, 2)
  assert.equal(tags(html, 'button', 'drw-bm__head').length, 2)
  assert.equal(tags(html, 'button', 'drw-bm__toggle').length, 1)
  assert.equal(tags(html, 'button', 'drw-bm__item').length, 2)

  const heads = tags(html, 'button', 'drw-bm__head')
  assert.ok(heads[0]?.includes('指南'))
  assert.equal(attr(heads[0] ?? '', 'aria-expanded'), 'true')
  assert.equal(attr(heads[1] ?? '', 'aria-expanded'), undefined, '没有子项的页面不应有折叠语义')

  const rows = tags(html, 'button', 'drw-bm__item')
  assert.equal(attr(rows[0] ?? '', 'title'), '安装 · 待生成')
  assert.equal(attr(rows[0] ?? '', 'disabled'), '', '待生成页面应禁用')
  assert.equal(attr(rows[0] ?? '', 'style'), 'padding-left:30px')
  assert.equal(attr(rows[1] ?? '', 'title'), '使用')
  assert.equal(attr(rows[1] ?? '', 'style'), 'padding-left:44px', 'depth=2 应按 CHILD_STEP 缩进')
  assert.equal(tags(html, 'span', 'drw-bm__badge').length, 1)
  assert.match(html, /<span class="drw-bm__badge"[^>]*><small class="drw-node-loading"/)
})

test('选中：受控 active 标记当前页，缺省时选中首个打开分组的首个子页', async () => {
  const heading = await render(items, { active: 'api' })
  const heads = tags(heading, 'button', 'drw-bm__head')
  assert.equal(attr(heads[0] ?? '', 'data-active'), undefined)
  assert.equal(attr(heads[1] ?? '', 'data-active'), '', 'active 指向顶层页面时应标记标题行')
  assert.equal(attr(heads[1] ?? '', 'aria-current'), 'page')

  const child = await render(items, { active: 'usage' })
  const rows = tags(child, 'button', 'drw-bm__item')
  assert.equal(attr(rows[0] ?? '', 'data-active'), undefined)
  assert.equal(attr(rows[1] ?? '', 'data-active'), '', 'active 指向子页时应标记对应子行')
  assert.equal(attr(rows[1] ?? '', 'aria-current'), 'page')
  assert.equal(attr(tags(child, 'button', 'drw-bm__head')[0] ?? '', 'data-active'), undefined)

  const fallback = await render(items)
  const fallbackRows = tags(fallback, 'button', 'drw-bm__item')
  assert.equal(attr(fallbackRows[0] ?? '', 'data-active'), '', '未传 active 时应选中首个打开分组的首个子页')
  assert.equal(attr(fallbackRows[0] ?? '', 'aria-current'), 'page')
})

test('折叠：open 控制分组展开与子行可聚焦状态，纯分组只折叠不可打开', async () => {
  const closed = await render(items, { open: [], labels: { expand: '展开', collapse: '折叠' } })
  assert.equal((closed.match(/class="drw-bm__section" data-open=""/g) ?? []).length, 0)
  assert.equal(attr(tags(closed, 'button', 'drw-bm__toggle')[0] ?? '', 'aria-expanded'), 'false')
  assert.equal(attr(tags(closed, 'button', 'drw-bm__toggle')[0] ?? '', 'aria-label'), '展开 指南')
  for (const row of tags(closed, 'button', 'drw-bm__item')) assert.equal(attr(row, 'tabindex'), '-1', '折叠时应退出 Tab 顺序')

  const opened = await render(items, { open: [0], labels: { expand: 'Expand', collapse: 'Collapse' } })
  assert.equal((opened.match(/class="drw-bm__section" data-open=""/g) ?? []).length, 1)
  assert.equal(attr(tags(opened, 'button', 'drw-bm__toggle')[0] ?? '', 'aria-expanded'), 'true')
  assert.equal(attr(tags(opened, 'button', 'drw-bm__toggle')[0] ?? '', 'aria-label'), 'Collapse 指南')
  for (const row of tags(opened, 'button', 'drw-bm__item')) assert.equal(attr(row, 'tabindex'), '0')

  const untouched = await render(items, { open: [1] })
  assert.equal((untouched.match(/class="drw-bm__section" data-open=""/g) ?? []).length, 0, '对无子项分组的 open 索引不产生展开')
})

test('搜索数据映射：只渲染过滤后的条目，并保留层级缩进与状态标题', async () => {
  const filtered: BranchedMenuItem[] = [
    { id: 'guide', label: '指南', children: [{ value: 'usage', label: '使用', depth: 2, title: '使用 · 待生成', disabled: true }] }
  ]
  const html = await render(filtered, { active: 'usage' })

  assert.equal(tags(html, 'div', 'drw-bm__section').length, 1, '未命中的顶层分组不应出现')
  assert.equal(tags(html, 'button', 'drw-bm__item').length, 1, '未命中的子页不应出现')
  assert.ok(html.includes('使用'))
  assert.equal(html.includes('安装'), false)
  assert.equal(html.includes('API'), false)
  const row = tags(html, 'button', 'drw-bm__item')[0] ?? ''
  assert.equal(attr(row, 'title'), '使用 · 待生成')
  assert.equal(attr(row, 'style'), 'padding-left:44px')

  const empty = await render([])
  assert.equal(tags(empty, 'div', 'drw-bm__section').length, 0)
  assert.match(empty, /^<nav class="drw-bm"/)
})

test('状态层级：data-state 按 ready / writing / pending 映射到分组与子页', async () => {
  const stateful: BranchedMenuItem[] = [
    {
      id: 'guide',
      label: '使用指南',
      state: 'ready',
      children: [
        { value: 'overview', label: '查看资料与用量', state: 'ready' },
        { value: 'build', label: '构建与静态检查', state: 'writing', disabled: true },
        { value: 'preview', label: '隔离预览与调试', state: 'pending', disabled: true },
      ],
    },
    {
      id: 'pending-group',
      label: '尚未生成分组',
      state: 'pending',
      children: [{ value: 'later', label: '待定页面', state: 'pending', disabled: true }],
    },
  ]
  const html = await render(stateful, { active: 'overview' })
  const heads = tags(html, 'button', 'drw-bm__head')
  const rows = tags(html, 'button', 'drw-bm__item')
  assert.equal(attr(heads[0] ?? '', 'data-state'), 'ready')
  assert.equal(attr(heads[1] ?? '', 'data-state'), 'pending')
  assert.equal(attr(rows[0] ?? '', 'data-state'), 'ready')
  assert.equal(attr(rows[1] ?? '', 'data-state'), 'writing')
  assert.equal(attr(rows[2] ?? '', 'data-state'), 'pending')
})

after(async () => {
  await rm(bundlePath, { force: true })
})
