#!/usr/bin/env node
/**
 * Repository Wiki local state retention. Dry-run by default; --apply removes only
 * selected job directories and non-current wiki revisions, never projects or the
 * current published revision.
 *
 * node scripts/prune-state.mjs
 * node scripts/prune-state.mjs --keep-jobs 50 --keep-revisions 2 --older-than-days 30
 * node scripts/prune-state.mjs --apply --older-than-days 30
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback
}
const apply = args.includes('--apply')
const keepJobs = value('--keep-jobs', 100)
const keepRevisions = value('--keep-revisions', 3)
const olderThanDays = value('--older-than-days', 30)
if (![keepJobs, keepRevisions, olderThanDays].every(n => Number.isFinite(n) && n >= 0)) throw new Error('retention limits must be non-negative numbers')
if (apply && !args.includes('--keep-jobs') && !args.includes('--keep-revisions') && !args.includes('--older-than-days')) throw new Error('--apply requires an explicit --keep-jobs/--keep-revisions/--older-than-days limit')
const stateDir = resolve(args.includes('--state') ? args[args.indexOf('--state') + 1] : process.env.DSH_HOME ? join(process.env.DSH_HOME, 'dsh-repowiki') : join(homedir(), '.dsh', 'dsh-repowiki'))
const cutoff = Date.now() - olderThanDays * 86400000
const safeId = /^[a-z0-9][a-z0-9-]{0,63}$/i
const kb = n => `${(n / 1024).toFixed(1)} KiB`
async function size(path) {
  const info = await stat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path).catch(() => [])) total += await size(join(path, entry))
  return total
}
const candidates = []
const jobsDir = join(stateDir, 'jobs')
const jobs = []
for (const entry of (await readdir(jobsDir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && safeId.test(entry.name))) {
  const path = join(jobsDir, entry.name)
  jobs.push({ path, bytes: await size(path), at: (await stat(path)).mtimeMs, kind: 'job' })
}
jobs.sort((a, b) => b.at - a.at)
for (const item of jobs.slice(keepJobs)) if (item.at < cutoff) candidates.push(item)
const wikisDir = join(stateDir, 'wikis')
for (const entry of await readdir(wikisDir, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isDirectory() || !safeId.test(entry.name)) continue
  const wikiDir = join(wikisDir, entry.name)
  const manifest = await readFile(join(wikiDir, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null)
  const current = manifest?.revision
  const revisionsDir = join(wikiDir, 'revisions')
  const revisions = (await readdir(revisionsDir, { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory() && safeId.test(item.name))
  const sorted = []
  for (const revision of revisions) {
    if (revision.name === current) continue
    const path = join(revisionsDir, revision.name)
    sorted.push({ path, bytes: await size(path), at: (await stat(path)).mtimeMs, kind: 'revision', wiki: entry.name })
  }
  sorted.sort((a, b) => b.at - a.at)
  for (const item of sorted.slice(keepRevisions)) if (item.at < cutoff) candidates.push(item)
}
for (const kind of ['job', 'revision']) {
  const selected = candidates.filter(item => item.kind === kind)
  const total = selected.reduce((sum, item) => sum + item.bytes, 0)
  console.log(`${kind}s: ${selected.length} candidate(s), ${kb(total)}`)
  for (const item of selected) console.log(`  ${apply ? 'delete' : 'would delete'} ${item.path} (${kb(item.bytes)})${item.wiki ? ` [${item.wiki}]` : ''}`)
}
if (apply) for (const item of candidates) await rm(item.path, { recursive: true, force: true })
console.log(apply ? 'retention applied.' : 'dry run; pass --apply with an explicit limit to delete.')
