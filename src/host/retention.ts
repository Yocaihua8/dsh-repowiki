import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageCandidate, StoragePlan } from '../shared/types.js'
import { WikiError } from './errors.js'

export interface RetentionOptions { keepJobs?: number; keepRevisions?: number; olderThanDays?: number }
const safe = /^[a-z0-9][a-z0-9-]{0,63}$/i
const options = (value: RetentionOptions = {}) => ({
  keepJobs: Number.isFinite(value.keepJobs) && value.keepJobs! >= 0 ? Math.floor(value.keepJobs!) : 100,
  keepRevisions: Number.isFinite(value.keepRevisions) && value.keepRevisions! >= 0 ? Math.floor(value.keepRevisions!) : 3,
  olderThanDays: Number.isFinite(value.olderThanDays) && value.olderThanDays! >= 0 ? value.olderThanDays! : 30,
})
async function size(path: string): Promise<number> {
  const info = await stat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path).catch(() => [])) total += await size(join(path, entry))
  return total
}
export async function planRetention(stateDir: string, value: RetentionOptions = {}): Promise<StoragePlan> {
  const { keepJobs, keepRevisions, olderThanDays } = options(value)
  const cutoff = Date.now() - olderThanDays * 86400000
  const jobs: Array<StorageCandidate & { path: string }> = []
  for (const entry of (await readdir(join(stateDir, 'jobs'), { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory() && safe.test(item.name))) {
    const path = join(stateDir, 'jobs', entry.name)
    jobs.push({ kind: 'job', id: entry.name, bytes: await size(path), at: (await stat(path)).mtimeMs, path })
  }
  jobs.sort((a, b) => b.at - a.at)
  const candidates: Array<StorageCandidate & { path: string }> = jobs.slice(keepJobs).filter(item => item.at < cutoff)
  for (const entry of (await readdir(join(stateDir, 'wikis'), { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory() && safe.test(item.name))) {
    const wikiDir = join(stateDir, 'wikis', entry.name)
    const manifest = await readFile(join(wikiDir, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null)
    const current = typeof manifest?.revision === 'string' ? manifest.revision : undefined
    const revisions: Array<StorageCandidate & { path: string }> = []
    for (const revision of (await readdir(join(wikiDir, 'revisions'), { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory() && safe.test(item.name))) {
      if (revision.name === current) continue
      const path = join(wikiDir, 'revisions', revision.name)
      revisions.push({ kind: 'revision', id: revision.name, wikiId: entry.name, bytes: await size(path), at: (await stat(path)).mtimeMs, path })
    }
    revisions.sort((a, b) => b.at - a.at)
    candidates.push(...revisions.slice(keepRevisions).filter(item => item.at < cutoff))
  }
  const publicCandidates = candidates.map(({ path: _, ...candidate }) => candidate)
  return { candidates: publicCandidates, jobs: publicCandidates.filter(item => item.kind === 'job').length, revisions: publicCandidates.filter(item => item.kind === 'revision').length, bytes: publicCandidates.reduce((sum, item) => sum + item.bytes, 0) }
}
export async function applyRetention(stateDir: string, plan: StoragePlan): Promise<void> {
  for (const candidate of plan.candidates) {
    if (!safe.test(candidate.id) || candidate.wikiId !== undefined && !safe.test(candidate.wikiId)) throw new WikiError('清理候选标识无效。', 'repowiki/retention-invalid')
    const path = candidate.kind === 'job'
      ? join(stateDir, 'jobs', candidate.id)
      : join(stateDir, 'wikis', candidate.wikiId!, 'revisions', candidate.id)
    await rm(path, { recursive: true, force: true })
  }
}
