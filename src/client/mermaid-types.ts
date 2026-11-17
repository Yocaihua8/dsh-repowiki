/**
 * 主包与 Mermaid 运行时 chunk 之间的类型契约。
 *
 * chunk 通过 `require.async('./client.mermaid.js')` 懒加载；主包只依赖这里的
 * 类型，不会把 mermaid 本体打进初始 bundle。
 */

/** 一次图表渲染的主题参数。 */
export interface MermaidThemeOptions {
  /** 当前页面是否为深色主题。 */
  dark: boolean
  /** 页面内容字体。 */
  fontFamily: string
  /** Mermaid base 主题变量。 */
  variables: Record<string, string | boolean>
}

/** 运行时 chunk 导出的能力。 */
export interface MermaidRuntime {
  /** 渲染一张图，返回 SVG 字符串；失败时抛出带可读原因的错误。 */
  renderMermaid(id: string, code: string, options: MermaidThemeOptions): Promise<string>
  /** 只做语法校验，不产生 DOM 输出。 */
  validateMermaid(code: string, options: MermaidThemeOptions): Promise<boolean>
}

/** 模块加载器提供给插件 factory 的 require 及其 chunk 异步入口。 */
export interface ChunkRequire {
  async(specifier: string): Promise<unknown>
}
