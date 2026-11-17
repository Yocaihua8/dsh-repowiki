/**
 * LLM 调用封装 — 复用宿主 ctx.llm 与发起会话的模型选择。
 *
 * 与 dsh-prompt-improver 的 enhance 相同的调用形状：
 * prepareCall(selection) → call.stream({...call.config, system, messages, signal})。
 * 本插件只消费文本增量与 finish 块，用内置累加器按流序拼接 text-delta。
 */
import type { Context } from '@deepseek-ai/cordis'
import { WikiError } from './errors.js'

/** 发起生成的会话 agent 的最小结构（工具执行时来自 exec.agent，富类型结构兼容）。 */
export interface GenerationAgent {
  id?: string
  session?: {
    requestHeader?: () => { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined } | undefined
  }
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 从会话 agent 提取当前模型选择；无法提取时抛 repowiki/no-model。 */
export function resolveSelection(agent: GenerationAgent | undefined): ModelSelection {
  const config = agent?.session?.requestHeader?.()?.config
  if (!config || typeof config.provider !== 'string' || config.provider.trim() === ''
    || typeof config.model !== 'string' || config.model.trim() === '') {
    throw new WikiError('未能获取当前会话的模型选择，请确认会话中已选择可用模型后重试。', 'repowiki/no-model')
  }
  const selection: ModelSelection = { provider: config.provider, model: config.model }
  if (typeof config.reasoningEffort === 'string' && config.reasoningEffort.trim() !== '') selection.reasoningEffort = config.reasoningEffort
  return selection
}

type LlmContext = Pick<Context, 'llm'>

/**
 * 单次补全：返回模型输出的全部文本。
 * @param options.sessionId 发起会话 id，用于请求归属（GenerateOptions 的 sessionId 为品牌类型，运行时即字符串）。
 */
export async function completeText(options: {
  llm: LlmContext['llm']
  selection: ModelSelection
  sessionId?: string
  system: string
  user: string
  signal: AbortSignal
  timeoutMs: number
}): Promise<string> {
  const { llm, selection, sessionId, system, user, signal, timeoutMs } = options
  if (!llm || typeof llm.prepareCall !== 'function') {
    throw new WikiError('宿主 llm 服务不可用，无法生成维基内容。', 'repowiki/llm-unavailable')
  }
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new WikiError('单次模型调用超时。', 'repowiki/timeout')), timeoutMs)
  const merged = AbortSignal.any([signal, timeout.signal])
  try {
    merged.throwIfAborted()
    const { reasoningEffort, ...route } = selection
    const call = await llm.prepareCall({ ...route, ...(reasoningEffort ? { reasoningEffort: reasoningEffort as never } : {}) }, merged)
    merged.throwIfAborted()
    let text = ''
    let finish: { kind: string } | null = null
    for await (const chunk of call.stream({
      ...call.config,
      ...(sessionId ? { sessionId: sessionId as never } : {}),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      signal: merged,
    })) {
      merged.throwIfAborted()
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason) finish = chunk.reason
    }
    merged.throwIfAborted()
    if (!finish) throw new WikiError('模型响应未完整结束。', 'repowiki/unexpected-result')
    if (finish.kind === 'aborted') throw new WikiError('生成已取消。', 'repowiki/cancelled')
    if (finish.kind === 'error') throw new WikiError('模型调用失败，请检查模型可用性。', 'repowiki/llm-error')
    if (finish.kind === 'max-tokens') throw new WikiError('模型输出被截断（max-tokens）。', 'repowiki/truncated')
    if (finish.kind !== 'stop') throw new WikiError('模型返回了未知的结束状态。', 'repowiki/unexpected-result')
    const trimmed = text.trim()
    if (trimmed === '') throw new WikiError('模型返回了空结果。', 'repowiki/empty-result')
    return trimmed
  } catch (error) {
    if (signal.aborted && !(error instanceof WikiError)) throw new WikiError('生成已取消。', 'repowiki/cancelled')
    if (timeout.signal.aborted && !(error instanceof WikiError)) throw new WikiError('单次模型调用超时。', 'repowiki/timeout')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 容错解析模型输出中的 JSON 对象：剥掉代码围栏，取第一个配平的花括号块。
 * @returns 解析失败返回 null，由调用方决定错误。
 */
export function extractJsonObject(text: string): unknown | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const withoutFences = text.replace(/```(?:json)?/giu, '```').split('```').reduce((longest, part) => {
    const trimmed = part.trim()
    if (trimmed.startsWith('{') && trimmed.length > longest.length) return trimmed
    return longest
  }, '')
  const candidate = withoutFences.trim() !== '' ? withoutFences : text
  const brace = candidate.indexOf('{')
  if (brace === -1) return null
  const source = candidate.slice(brace)
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(source.slice(0, index + 1)) } catch { return null }
      }
    }
  }
  return null
}
