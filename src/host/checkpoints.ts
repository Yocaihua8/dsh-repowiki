import { mkdir, readdir, readFile, copyFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
import type { GenerationStatus, KnowledgeCard, ModelSelection, PageReviewMeta, ProjectSettings, SourceExcerpt, CardEvidence } from '../shared/types.js'
import type { WikiOutline } from './prompts.js'
import type { RepositorySnapshot } from './snapshot.js'
import type { WritePageInput } from './store.js'
import { assertSafeId } from './store.js'
import { atomicJson } from './settings.js'
import { WikiError } from './errors.js'

export interface Checkpoint {
  schemaVersion: 1 | 2; status: GenerationStatus; selection: ModelSelection; settings: ProjectSettings
  engine?: 'agent-v1'
  /** New quality contract; absent in old checkpoints, which resume unchanged. */
  qualityPolicy?: 'enforce' | 'legacy'
  /** New planning contract; absent in old checkpoints, which resume unchanged. */
  readingPlanRequired?: boolean
  agentState?: AgentCheckpoint
  mode: 'generate' | 'update'; commit?: string; sessionId?: string
  outline?: WikiOutline; analysis?: string; pages: WritePageInput[]; cards: KnowledgeCard[]; verified: string[]
}
export interface AgentCheckpoint {
  sessionId: string; sessionCreated: boolean; progress: number; stalledRounds: number
  evidence: SourceExcerpt[]
  revisions: { version: number; reason: string; outline: WikiOutline; at: string }[]
  receipts: Record<string, { digest: string; result: unknown }>
  verifications: Record<string, { digest: string; supported: boolean; issues: string[]; claims: { claim: string; evidence: CardEvidence[] }[]; review?: PageReviewMeta; mode?: 'model' | 'host-rule' }>
  /** 规划阶段失败记录（最近 3 条）；outline 超 80 节点时存 null。旧 checkpoint 无此字段。 */
  plannerFailures?: { at: string; error: string; outline: WikiOutline | null }[]
}

/** Keep the structured checkpoint bounded; large evidence/receipts live in separate shards. */
export const CHECKPOINT_LIMITS = Object.freeze({
  checkpointBytes: 8 * 1024 * 1024,
  evidenceBytes: 16 * 1024 * 1024,
  receiptsBytes: 4 * 1024 * 1024,
  receiptsEntries: 2000,
})
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null')
function referencedEvidence(data: Checkpoint): Set<string> {
  const ids = new Set<string>()
  for (const page of data.pages) for (const source of page.sources ?? []) ids.add(source.id)
  for (const card of data.cards) for (const item of card.evidence) ids.add(item.sourceId)
  for (const verification of Object.values(data.agentState?.verifications ?? {}))
    for (const claim of verification.claims) for (const item of claim.evidence) ids.add(item.sourceId)
  return ids
}
/** Keep all evidence referenced by committed work; otherwise keep the newest excerpts within the shard bound. */
function pruneEvidence(data: Checkpoint): SourceExcerpt[] {
  const evidence = data.agentState?.evidence ?? []
  if (bytes(evidence) <= CHECKPOINT_LIMITS.evidenceBytes) return evidence
  const referenced = referencedEvidence(data), keep = new Set<string>()
  let used = 0
  for (const source of evidence) if (referenced.has(source.id)) {
    used += bytes(source)
    if (used > CHECKPOINT_LIMITS.evidenceBytes) throw new WikiError('checkpoint evidence 超过安全上界，已停止写入；请缩小项目范围或重新生成。', 'repowiki/checkpoint-limit')
    keep.add(source.id)
  }
  for (let index = evidence.length - 1; index >= 0 && used < CHECKPOINT_LIMITS.evidenceBytes; index--) {
    const source = evidence[index]!
    if (keep.has(source.id)) continue
    const size = bytes(source)
    if (used + size > CHECKPOINT_LIMITS.evidenceBytes) continue
    keep.add(source.id); used += size
  }
  return evidence.filter(source => keep.has(source.id))
}
function pruneReceipts(receipts: AgentCheckpoint['receipts']): AgentCheckpoint['receipts'] {
  const entries = Object.entries(receipts)
  if (!entries.length) return receipts
  // 单遍计算每条回执的字节数，再从头丢弃；避免在循环条件里反复序列化整份回执表。
  const sizes = entries.map(([key, value]) => Buffer.byteLength(JSON.stringify({ [key]: value })) + 1)
  let total = sizes.reduce((sum, size) => sum + size, 0) + 1
  let drop = 0
  while (drop < entries.length && (entries.length - drop > CHECKPOINT_LIMITS.receiptsEntries || total > CHECKPOINT_LIMITS.receiptsBytes)) {
    total -= sizes[drop]!
    drop++
  }
  return drop === 0 ? receipts : Object.fromEntries(entries.slice(drop))
}
function stripState(data: Checkpoint): Checkpoint {
  const disk = structuredClone(data)
  if (!disk.agentState) return disk
  disk.agentState.evidence = []
  disk.agentState.receipts = {}
  return disk
}
export class CheckpointStore {
  private writes = new Map<string, Promise<void>>()
  constructor(readonly directory: string) {}
  private path(id: string, name: string) { return join(this.directory, 'jobs', assertSafeId(id, 'jobId'), name) }
  async save(data: Checkpoint): Promise<void> {
    const id = data.status.jobId!, captured = structuredClone(data)
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.commit(id, captured))
    this.writes.set(id, next)
    try { await next } finally { if (this.writes.get(id) === next) this.writes.delete(id) }
  }
  private async commit(id: string, data: Checkpoint) {
    const file = this.path(id, 'checkpoint.json')
    await mkdir(join(this.directory, 'jobs', id), { recursive: true })
    const evidence = data.agentState ? pruneEvidence(data) : []
    const receipts = data.agentState ? pruneReceipts(data.agentState.receipts) : {}
    if (data.agentState) { data.agentState.evidence = evidence; data.agentState.receipts = receipts }
    const disk = stripState(data)
    if (Buffer.byteLength(JSON.stringify(disk)) > CHECKPOINT_LIMITS.checkpointBytes) throw new WikiError('checkpoint 结构超过安全上界，已停止写入；请缩小项目范围或重新生成。', 'repowiki/checkpoint-limit')
    const previous = await readFile(file, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return null })
    if (previous !== null) {
      let valid = false
      try { const parsed = JSON.parse(previous) as Checkpoint; valid = [1, 2].includes(parsed.schemaVersion) && parsed.status.jobId === id } catch { /* Keep the recoverable backup. */ }
      await copyFile(file, this.path(id, valid ? 'checkpoint.previous.json' : `checkpoint.corrupt-${Date.now()}.json`))
    }
    if (data.agentState) {
      await atomicJson(this.path(id, 'evidence.json'), evidence)
      await atomicJson(this.path(id, 'receipts.json'), receipts)
    }
    await atomicJson(file, disk)
  }
  private async hydrate(id: string, value: Checkpoint): Promise<Checkpoint> {
    if (!value.agentState) return value
    const read = async (name: string): Promise<unknown> => {
      try { return JSON.parse(await readFile(this.path(id, name), 'utf8')) } catch { return undefined }
    }
    const [evidence, receipts] = await Promise.all([read('evidence.json'), read('receipts.json')])
    value.agentState.evidence = Array.isArray(evidence) ? evidence as SourceExcerpt[] : value.agentState.evidence ?? []
    value.agentState.receipts = receipts && typeof receipts === 'object' && !Array.isArray(receipts) ? receipts as AgentCheckpoint['receipts'] : value.agentState.receipts ?? {}
    return value
  }
  /**
   * 源码快照落盘。10,000 文件上限意味着快照可达上百 MB，
   * 因此按 gzip 压缩后原子写入，避免 JSON 明文放大与写入停顿。
   */
  async saveSnapshot(id: string, snapshot: RepositorySnapshot): Promise<void> {
    const target = this.path(id, 'snapshot.json.gz')
    await mkdir(join(this.directory, 'jobs', id), { recursive: true })
    const body = await gzipAsync(Buffer.from(JSON.stringify(snapshot), 'utf8'), { level: 6 })
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, body)
    await rename(temporary, target)
  }

  async snapshot(id: string): Promise<RepositorySnapshot | undefined> {
    // 兼容旧任务的未压缩快照（snapshot.json）。
    try { return JSON.parse((await gunzipAsync(await readFile(this.path(id, 'snapshot.json.gz')))).toString('utf8')) as RepositorySnapshot }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    try { return JSON.parse(await readFile(this.path(id, 'snapshot.json'), 'utf8')) as RepositorySnapshot }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  }
  async list(): Promise<Checkpoint[]> {
    const entries = await readdir(join(this.directory, 'jobs')).catch(() => [] as string[]), result: Checkpoint[] = []
    for (const id of entries.filter(id => /^[a-z0-9-]{1,64}$/.test(id))) {
      for (const name of ['checkpoint.json', 'checkpoint.previous.json']) {
        try {
          const value = JSON.parse(await readFile(this.path(id, name), 'utf8')) as Checkpoint
          if (![1, 2].includes(value.schemaVersion) || value.status.jobId !== id || !Array.isArray(value.pages) || !Array.isArray(value.cards)) continue
          result.push(await this.hydrate(id, value)); break
        } catch { /* Preserve unreadable data; recover from the previous atomic checkpoint. */ }
      }
    }
    return result.sort((a, b) => (a.status.startedAt ?? '').localeCompare(b.status.startedAt ?? ''))
  }
}
