/**
 * Wiki 子代理工具面收窄 helper 的宿主分支覆盖：
 * 旧宿主（0.2.1-rc.4 / rc.5）仍有每-scope 的 `presentAs`，0.2.2-rc.1 起该入口已删除。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import { restrictToScopedToolsNatively } from '../src/host/tool-scope.js'

type Call = { method: string, args: unknown }

/** `legacy: true` 模拟 rc.4 / rc.5 的 `ToolsService`（带 presentAs），false 模拟 0.2.2-rc.1。 */
function fakeTools(legacy: boolean): { tools: ToolsService, calls: Call[] } {
  const calls: Call[] = []
  const record = (method: string) => (args: unknown) => { calls.push({ method, args }); return () => {} }
  const tools = { restrict: record('restrict'), ...(legacy ? { presentAs: record('presentAs') } : {}) } as unknown as ToolsService
  return { tools, calls }
}

test('legacy hosts keep the per-scope native presentation override', () => {
  const { tools, calls } = fakeTools(true)
  restrictToScopedToolsNatively(tools)
  assert.deepEqual(calls, [{ method: 'restrict', args: { allow: [] } }, { method: 'presentAs', args: 'native' }])
})

test('0.2.2-rc.1 selects presentation through the mounted executor, so restrict alone is used', () => {
  const { tools, calls } = fakeTools(false)
  restrictToScopedToolsNatively(tools)
  assert.deepEqual(calls, [{ method: 'restrict', args: { allow: [] } }])
})
