/** 测试助手：fake 宿主上下文、临时目录、fixture 仓库、fake llm。 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-repowiki-test-'))
  t.after(() => { /* 交给测试进程退出后由系统清理；避免跨平台 rm 竞态 */ })
  return dir
}

/** 手写 fake 宿主：provide/effect/tools.register/get/logger，形状对齐 dsh-voice 的 plugin.test.mjs。 */
export function fakeContext({ llm } = {}) {
  const provided = new Map()
  const tools = []
  const effects = []
  const webRoutes = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    provide: (serviceName, value) => {
      provided.set(serviceName, value)
      return () => provided.delete(serviceName)
    },
    effect: (factory, label) => {
      effects.push(label)
      return factory()
    },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    get: (name) => (name === 'llm' ? llm : undefined),
    llm,
    webServer: { register: (route) => { webRoutes.push(route); return () => {} } },
  }
  return { ctx, provided, tools, effects, webRoutes }
}

/** 生成一个流式 fake llm：每批回复通过 handlers 配置。 */
export function fakeLlm(handlers) {
  const calls = []
  const llm = {
    calls,
    async prepareCall(selection, signal) {
      const config = { ...selection }
      return {
        config,
        stream: async function* (options) {
          calls.push({ selection, options })
          const respond = handlers.shift() ?? handlers.at(-1)
          if (!respond) throw new Error('fake llm: 没有配置回复')
          const chunks = await respond({ selection, options }, signal)
          for (const chunk of chunks) {
            signal?.throwIfAborted()
            yield chunk
          }
        },
      }
    },
  }
  return llm
}

export function textChunks(text) {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }]
  const size = 64
  for (let index = 0; index < text.length; index += size) {
    chunks.push({ type: 'text-delta', index: 0, text: text.slice(index, index + size) })
  }
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
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
export async function makeRepo(t, { root = '' } = {}) {
  const repo = root || join(await tempDir(t), 'sample-repo')
  await mkdir(repo, { recursive: true })
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
