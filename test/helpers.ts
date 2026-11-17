/** 测试助手：fake 宿主上下文、临时目录、fixture 仓库、fake llm 流。 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export async function tempDir(t: { after: (fn: () => void) => void }): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-repowiki-test-'))
}

/** 可注入 fake llm：按 handlers 顺序回复。 */
export interface FakeLlmCall {
  selection?: unknown
  options?: GenerateOptions
  signal?: AbortSignal
}

export function fakeLlm(handlers: Array<() => Promise<StreamChunk[]> | StreamChunk[]>, extras: { card?: (options: GenerateOptions) => Promise<StreamChunk[]> | StreamChunk[]; verify?: (options: GenerateOptions) => Promise<StreamChunk[]> | StreamChunk[] } = {}): {
  prepareCall: (selection: unknown, signal?: AbortSignal) => Promise<{
    config: Record<string, unknown>
    stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>
  }>
  calls: FakeLlmCall[]
  auxiliaryCalls: FakeLlmCall[]
} {
  const calls: FakeLlmCall[] = []
  const auxiliaryCalls: FakeLlmCall[] = []
  return {
    calls,
    auxiliaryCalls,
    async prepareCall(selection, signal) {
      return {
        config: { ...(selection as Record<string, unknown>) },
        stream: async function* (options) {
          const card = options.system?.includes('提炼一张供智能体检索'), verify = options.system?.includes('逐项核对 Wiki 与卡片')
          ;(card || verify ? auxiliaryCalls : calls).push({ selection, options, signal })
          const respond = card ? () => extras.card ? extras.card(options) : (() => {
            const content = options.messages?.[0]?.content
            const input = JSON.parse(Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : '{}')
            const source = input.sources[0]
            return textChunks(JSON.stringify({ title: input.page.title, category: 'architecture', summary: 'Fixture knowledge', content: 'Fixture knowledge', evidence: [{ path: source.path, startLine: 1, endLine: 1, quote: source.text.split('\n')[0] }] }))
          })() : verify ? () => extras.verify ? extras.verify(options) : textChunks('{"supported":true,"issues":[]}') : handlers.shift()
          if (!respond) throw new Error('fake llm: 没有配置回复')
          // 挂起的回复也要能被取消打断。
          const chunks = await Promise.race([
            Promise.resolve().then(respond),
            new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) { reject(signal.reason); return }
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
            }),
          ])
          for (const chunk of chunks) {
            signal?.throwIfAborted()
            yield chunk
          }
        },
      }
    },
  }
}

export function textChunks(text: string, finish = 'stop'): StreamChunk[] {
  const chunks: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
  const size = 64
  for (let index = 0; index < text.length; index += size) {
    chunks.push({ type: 'text-delta', index: 0, text: text.slice(index, index + size) })
  }
  chunks.push({ type: 'finish', reason: { kind: finish } } as StreamChunk)
  return chunks
}

export const PLAN_JSON = JSON.stringify({
  title: '示例仓库维基',
  description: '一个示例仓库的维基。',
  pages: [
    { id: 'overview', title: '项目总览', summary: '整体介绍。', relatedPaths: ['README.md'] },
    { id: 'architecture', title: '架构说明', summary: '模块划分。', relatedPaths: ['src'] },
  ],
})

/** 建 fixture 仓库：README + package.json + 少量源码 + 应跳过的目录。 */
export async function makeRepo(t: { after: (fn: () => void) => void }, root = ''): Promise<string> {
  const repo = root || join(await tempDir(t), 'sample-repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true })
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(join(repo, 'dist'), { recursive: true })
  await writeFile(join(repo, 'README.md'), '# 示例仓库\n\n一个用于测试的示例仓库。\n')
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'sample-repo', version: '1.0.0', main: 'src/index.js' }, null, 2))
  await writeFile(join(repo, 'src', 'index.js'), 'export function main() {\n  return greet()\n}\n')
  await writeFile(join(repo, 'src', 'util.js'), 'export function greet() {\n  return "hello"\n}\n')
  await writeFile(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = () => 0\n')
  await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(repo, 'dist', 'bundle.js'), 'console.log("built")\n')
  return repo
}
