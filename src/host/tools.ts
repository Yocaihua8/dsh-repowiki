/**
 * 会话工具注册：repowiki_generate / repowiki_status / repowiki_list / repowiki_read。
 *
 * 工具直接驱动同进程的 WikiPipeline；generate 启动后台任务后立即返回。
 * 形状沿用 dsh-voice / dsh-memory 的 ToolDefinition 模式。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WikiPipeline } from './pipeline.js'
import { WikiError } from './errors.js'

const output = {
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

export function registerRepoWikiTools(ctx: Pick<Context, 'tools'>, pipeline: WikiPipeline): (() => void)[] {
  const definitions: ToolDefinition[] = [
    {
      name: 'repowiki_generate',
      description: '为本地仓库生成多页维基，返回后台 jobId；用 repowiki_status 查询。优先使用项目保存的模型，否则使用会话模型。同项目去重，其他项目排队；cancel=true 显式取消。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库根目录的绝对路径；Wiki 存入插件目录，启用自动导出时也写入项目 .dsh/repowiki。' },
          cancel: { type: 'boolean', description: 'true 时取消当前正在进行的生成任务，此时无需 path。' },
          jobId: { type: 'string', description: '取消指定任务；省略时兼容取消当前任务。' },
          mode: { type: 'string', enum: ['generate', 'update'], description: 'generate 完整生成；update 使用当前 Git 提交增量更新。' },
        },
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        const request = (args ?? {}) as { path?: unknown; cancel?: unknown; jobId?: string; mode?: 'generate' | 'update' }
        if (request.cancel === true) return pipeline.cancel(request.jobId)
        if (typeof exec?.signal !== 'undefined') exec.signal.throwIfAborted()
        return pipeline.start({ repoPath: request.path, agent: exec?.agent, signal: exec?.signal, mode: request.mode })
      },
    },
    {
      name: 'repowiki_status',
      description: '查询仓库维基生成任务的进度：阶段、页数、错误或已完成的结果摘要。',
      parameters: { type: 'object', properties: { jobId: { type: 'string', description: '指定任务 ID；省略时查询当前任务。' } }, required: [], additionalProperties: false },
      output,
      async execute(args) {
        return pipeline.status((args as { jobId?: string } | undefined)?.jobId)
      },
    },
    {
      name: 'repowiki_list',
      description: '列出已生成的仓库维基（含进行中的任务）。先用它找到 wikiId，再用 repowiki_read 阅读。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output,
      async execute() {
        return { wikis: await pipeline.list(), jobs: pipeline.statuses() }
      },
    },
    {
      name: 'repowiki_read',
      description: '阅读仓库维基：不带 pageId 返回目录（各页标题与摘要），带 pageId 返回该页 Markdown 全文。',
      parameters: {
        type: 'object',
        properties: {
          wikiId: { type: 'string', description: '维基 id，来自 repowiki_list。' },
          pageId: { type: 'string', description: '页面 id；省略时返回目录。' },
        },
        required: ['wikiId'],
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const request = (args ?? {}) as { wikiId?: unknown; pageId?: unknown }
        const wikiId = typeof request.wikiId === 'string' ? request.wikiId.trim() : ''
        if (wikiId === '') throw new WikiError('请提供 wikiId。', 'repowiki/missing-wiki-id')
        if (request.pageId === undefined || request.pageId === null || request.pageId === '') {
          return { wiki: await pipeline.readManifest(wikiId), page: null }
        }
        return { wiki: await pipeline.readManifest(wikiId), page: await pipeline.readPage(wikiId, request.pageId) }
      },
    },
  ]
  return definitions.map(definition => ctx.tools.register(definition))
}
