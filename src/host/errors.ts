/** 仓库维基插件统一错误：code 形如 repowiki/<reason>，跨 RPC/工具边界只透传这一个形状。 */
export class WikiError extends Error {
  readonly code: string
  constructor(message: string, code = 'repowiki/failed', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WikiError'
    this.code = code
  }
}
