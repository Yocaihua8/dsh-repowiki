import { mkdir, readFile, readdir, rename, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModelSelection, ProjectSettings, RoleModels } from '../shared/types.js'
import { WikiError } from './errors.js'
import { wikiIdFor } from './store.js'

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporary, path)
}

export interface ProjectRecord { path: string; settings: ProjectSettings; blockedCommit: string | null; updateNotice: string | null }
function validModel(value: unknown): value is ModelSelection {
  const m = value as ModelSelection | null
  return m === null || !!m && typeof m.provider === 'string' && m.provider.trim() !== '' && typeof m.model === 'string' && m.model.trim() !== ''
    && m.provider.length <= 200 && m.model.length <= 4096
    && (m.reasoningEffort === undefined || typeof m.reasoningEffort === 'string' && m.reasoningEffort.length <= 80)
}
function normalizeModel(value: unknown): ModelSelection | null {
  if (!validModel(value)) throw new WikiError('模型设置无效。', 'repowiki/settings')
  const m = value as ModelSelection | null
  return m === null ? null : { provider: m.provider, model: m.model, ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}) }
}
export function validateSettings(value: ProjectSettings): ProjectSettings {
  if (!value || !['zh', 'en'].includes(value.language) || !Number.isInteger(value.maxPages)
    || value.maxPages < 1 || value.maxPages > 64 || typeof value.autoUpdate !== 'boolean' || typeof value.autoExport !== 'boolean') {
    throw new WikiError('项目设置无效。', 'repowiki/settings')
  }
  if (value.collaboration !== undefined && !['single', 'collaborative'].includes(value.collaboration)) throw new WikiError('协作模式无效。', 'repowiki/settings')
  if (value.concurrency !== undefined && ![1, 2, 3].includes(value.concurrency)) throw new WikiError('并发设置无效。', 'repowiki/settings')
  if (value.roles !== undefined && (!value.roles || typeof value.roles !== 'object' || Array.isArray(value.roles))) throw new WikiError('角色模型设置无效。', 'repowiki/settings')
  const roles: RoleModels = { planner: normalizeModel(value.roles?.planner ?? null), writer: normalizeModel(value.roles?.writer ?? null), verifier: normalizeModel(value.roles?.verifier ?? null) }
  return { language: value.language, maxPages: value.maxPages, autoUpdate: value.autoUpdate, autoExport: value.autoExport,
    agentReference: value.agentReference === true, collaboration: value.collaboration ?? 'collaborative', concurrency: value.concurrency ?? 2, roles,
    model: normalizeModel(value.model), exclude: normalizeExclude(value.exclude) }
}

/** 手工排除规则：.gitignore 语法，单条 ≤ 200 字符，最多 200 条。 */
function normalizeExclude(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new WikiError('排除规则必须是字符串数组。', 'repowiki/settings')
  if (value.length > 200) throw new WikiError('排除规则最多 200 条。', 'repowiki/settings')
  const rules = value.map(rule => {
    if (typeof rule !== 'string') throw new WikiError('排除规则必须是字符串。', 'repowiki/settings')
    const trimmed = rule.trim()
    if (trimmed.length > 200) throw new WikiError('单条排除规则不得超过 200 字符。', 'repowiki/settings')
    return trimmed
  }).filter(rule => rule !== '')
  return rules
}

export class ProjectSettingsStore {
  private readonly writes = new Map<string, Promise<void>>()
  constructor(readonly stateDir: string, readonly defaults: ProjectSettings) {}
  async read(path: string): Promise<ProjectRecord> {
    const resolved = resolve(path)
    const file = join(this.stateDir, 'projects', `${wikiIdFor(resolved)}.json`)
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as ProjectRecord
      return { path: resolved, settings: validateSettings(data.settings), blockedCommit: data.blockedCommit ?? null, updateNotice: data.updateNotice ?? null }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new WikiError('项目设置读取失败。', 'repowiki/settings', error)
      // A pre-settings Wiki is an existing project: automatic reference remains opt-in.
      const legacy = await readFile(join(this.stateDir, 'wikis', wikiIdFor(resolved), 'manifest.json')).then(() => true).catch(() => false)
      return { path: resolved, settings: { ...structuredClone(this.defaults), agentReference: !legacy }, blockedCommit: null, updateNotice: null }
    }
  }
  async write(record: ProjectRecord): Promise<void> {
    const file = join(this.stateDir, 'projects', `${wikiIdFor(record.path)}.json`)
    await copyFile(file, `${file}.pre-v3.bak`, 1).catch(e => { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e })
    await copyFile(file, file + '.pre-v5.bak', 1).catch(e => { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e })
    await atomicJson(join(this.stateDir, 'projects', `${wikiIdFor(record.path)}.json`), { ...record, settings: validateSettings(record.settings) })
  }
  async update(path: string, mutate: (record: ProjectRecord) => ProjectRecord): Promise<void> {
    const key = wikiIdFor(path)
    const previous = this.writes.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => this.write(mutate(await this.read(path))))
    this.writes.set(key, next)
    try { await next } finally { if (this.writes.get(key) === next) this.writes.delete(key) }
  }
  async list(): Promise<ProjectRecord[]> {
    const dir = join(this.stateDir, 'projects')
    const entries = await readdir(dir).catch(() => [] as string[])
    const result: ProjectRecord[] = []
    for (const entry of entries.filter(e => /^[a-z0-9-]+\.json$/.test(e))) {
      try {
        const data = JSON.parse(await readFile(join(dir, entry), 'utf8')) as ProjectRecord
        if (wikiIdFor(data.path) === entry.slice(0, -5)) result.push(await this.read(data.path))
      } catch { /* A damaged record does not disable other projects. */ }
    }
    return result
  }
}
