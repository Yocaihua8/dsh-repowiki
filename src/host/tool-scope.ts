/**
 * Wiki 子代理的工具面收窄：只保留该 scope 自己注册的 wiki_* 工具。
 *
 * 宿主差异（0.2.2-rc.1 适配）：
 * - 0.2.1-rc.4 / rc.5：呈现方式（native Function Calling 还是 PTC 的 `run_code`）
 *   是 `ToolsService` 上的每-scope 开关 `presentAs(mode)`，所以只 `restrict` 不够，
 *   还要显式声明 native，否则部署默认 `mode: 'ptc'` 时模型只看到 `run_code`。
 * - 0.2.2-rc.1：`presentAs` 与 `Config.mode` 一起删除（`ToolsService.Config.mode`
 *   变成 `z.never()`，说明文字改为 “Removed. Mount a native or PTC tool executor
 *   instead.”），呈现方式改由组合挂载的 executor 决定：native executor 只描述
 *   `definitions(scope)`（含本 scope 注册的 wiki 工具），`run_code` 只由 PTC
 *   executor 在自己的 `describe()` 里给出，注册表层根本不存在该项，
 *   因此 `restrict()` 也无法点名它（报错 “reserved PTC mode presentation
 *   transport `run_code`”）。宿主基础组合默认挂载 native、PTC 行 disabled，
 *   所以新宿主分支只需 restrict：意图已由 restrict + scope 注册达成。
 */
import type { ToolsService } from '@deepseek-ai/dsh-tools'

/** 旧宿主（0.2.1-rc.4 / rc.5）才有该开关；0.2.2-rc.1 起呈现由 executor 组合决定。 */
type LegacyPresentationTools = ToolsService & { presentAs?: (mode: 'native') => () => void }

/**
 * 把子代理可见的全局工具清空（本 scope 注册的 wiki 工具不受影响），
 * 并在仍支持每-scope 呈现开关的旧宿主上声明 native 呈现。
 * @param tools - 子代理 scope 上的 `tools` 服务。
 */
export function restrictToScopedToolsNatively(tools: ToolsService): void {
  tools.restrict({ allow: [] })
  const legacy = tools as LegacyPresentationTools
  // 运行时特性检测，不用构建期分支：声明的宿主范围是 rc.4 || rc.5 || 0.2.2-rc.1 的并集。
  if (typeof legacy.presentAs === 'function') legacy.presentAs('native')
}
