/**
 * GooeyNav（React Bits 流体导航）的最小自动测试。
 * 与 branched-menu / task-components 测试一致：esbuild + react-dom/server，无 DOM。
 */
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
const esbuild = require('esbuild') as typeof import('esbuild')

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundlePath = join(here, `.gooey-nav.test.${process.pid}.mjs`)

let navModule: Promise<{ GooeyNav: (props: Record<string, unknown>) => unknown }> | undefined

function loadNav() {
  navModule ??= (async () => {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [join(root, 'src/client/gooey-nav.tsx')],
      outfile: bundlePath,
      bundle: true,
      write: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime'],
      logLevel: 'silent',
    })
    return await import(pathToFileURL(bundlePath).href)
  })()
  return navModule
}

async function render(props: Record<string, unknown>): Promise<string> {
  const { GooeyNav } = await loadNav()
  return renderToStaticMarkup(React.createElement(GooeyNav as never, props as never))
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
}

test('GooeyNav：selection 模式渲染 div[role=group]、活动项与无 href 的按钮项', async () => {
  const html = await render({
    items: [{ label: '简体中文' }, { label: 'English' }, { label: '深度', href: '#deep' }],
    activeIndex: 1,
    ariaLabel: '生成语言',
    size: 'sm',
    frame: true,
    mode: 'selection',
    className: 'drw-gn-setting',
  })

  const group = /<div[^>]*role="group"[^>]*>/.exec(html)?.[0] ?? ''
  assert.match(group, /class="drw-gn drw-gn--sm drw-gn--framed drw-gn-setting"/)
  assert.equal(attr(group, 'aria-label'), '生成语言')
  assert.equal(attr(group, 'role'), 'group', '设置选择器不应成为页面导航 landmark')
  assert.equal(/<nav\b/.test(html), false, 'selection 模式应使用 div 而非 nav')

  const main = html.split('drw-gn__list--active')[0] ?? ''
  assert.equal((main.match(/class="drw-gn__item"/g) ?? []).length, 3)
  assert.equal((main.match(/<button/g) ?? []).length, 2, '无 href 的项应渲染为按钮')
  assert.equal((main.match(/<a /g) ?? []).length, 1, '带 href 的项应渲染为链接')

  const active = /<li[^>]*data-active=""[^>]*>/.exec(main)?.[0] ?? ''
  assert.match(active, /data-gooey-index="1"/)
  assert.equal(attr(active, 'data-active'), '')
  const activeButton = /<button[^>]*aria-pressed="true"[^>]*>/.exec(main)?.[0] ?? ''
  assert.equal(attr(activeButton, 'aria-pressed'), 'true', 'English 是无 href 的活动按钮')
  assert.equal((main.match(/<button[^>]*aria-pressed="false"/g) ?? []).length, 1, '未选中按钮应标记 aria-pressed=false')
  const link = /<a [^>]*href="#deep"[^>]*>/.exec(main)?.[0] ?? ''
  assert.equal(attr(link, 'href'), '#deep')
})

test('GooeyNav：activeIndex 越界时收敛到有效范围，默认 nav 模式与主题写入药丸颜色', async () => {
  const html = await render({
    items: [{ label: '标准' }, { label: '深度' }],
    activeIndex: 99,
    theme: 'light',
    ariaLabel: '目录粒度',
  })
  assert.match(html, /^<nav\b/, '默认 nav 模式应渲染 nav 元素')
  const main = html.split('drw-gn__list--active')[0] ?? ''
  const active = /<li[^>]*data-active=""[^>]*>/.exec(main)?.[0] ?? ''
  assert.match(active, /data-gooey-index="1"/, '越界索引应显示最后一项')
  assert.match(html, /--gn-pill:#27272a/)
  assert.match(html, /--gn-active-ink:#ffffff/)
})

test('GooeyNav：disabled 态标记容器、按钮 disabled 与链接 aria-disabled', async () => {
  const html = await render({
    items: [{ label: '简体中文' }, { label: '文档', href: '#doc' }],
    activeIndex: 0,
    mode: 'selection',
    disabled: true,
    ariaLabel: '生成语言',
  })
  const group = /<div[^>]*role="group"[^>]*>/.exec(html)?.[0] ?? ''
  assert.match(group, /drw-gn--disabled/)
  assert.equal(attr(group, 'aria-disabled'), 'true')
  const main = html.split('drw-gn__list--active')[0] ?? ''
  assert.match(main, /<button[^>]*disabled=""/)
  assert.match(main, /<a [^>]*aria-disabled="true"[^>]*tabindex="-1"/)
})

after(async () => {
  await rm(bundlePath, { force: true })
})
