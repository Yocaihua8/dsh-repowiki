import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import type { RepositoryVersion, SourceExcerpt } from '../shared/types.js'
import { commitFiles, gitState, readCommitFile } from './git.js'
import { decodeBounded, excludeMatcher, isAllowedPath, isSourcePath, pickExcerpts, readExcerpts, scanRepo, SCAN_LIMITS, type ScanMaterial } from './scanner.js'
import { WikiError } from './errors.js'

export interface RepositorySnapshot {
  root: string
  tree: string[]
  files: SourceExcerpt[]
  source: RepositoryVersion
  truncated: boolean
  /** 工作区快照的文件元信息（size + mtimeMs），用于快速变更检测，避免反复全量读盘哈希。 */
  fileStats?: Record<string, { size: number; mtimeMs: number }>
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const SNAPSHOT_BUDGET = 8 * 1024 * 1024
/**
 * Agent 模式的正文读取预算。10,000 文件硬上限按平均 8 KB/文件估算约 80 MB，
 * 取 256 MiB 留出余量；快照持久化已改为 gzip，磁盘占用约为原文的 1/4~1/5。
 */
export const AGENT_READ_BUDGET = 256 * 1024 * 1024

/** Read one immutable, bounded input set. Automatic updates read commit blobs, never the live working tree. */
export async function captureSnapshot(root: string, commit: string | undefined, signal: AbortSignal, agent = false, exclude?: readonly string[]): Promise<RepositorySnapshot> {
  const limits = agent ? { ...SCAN_LIMITS, maxFileBytes: 8 * 1024 * 1024, totalBudgetBytes: AGENT_READ_BUDGET } : SCAN_LIMITS
  const budget = agent ? AGENT_READ_BUDGET : SNAPSHOT_BUDGET
  const manual = excludeMatcher(exclude)
  const state = await gitState(root, signal)
  let tree: string[] = []
  let texts: { path: string; text: string; truncated: boolean }[] = []
  let truncated = false
  if (commit) {
    if (!state.available) throw new WikiError('Git 仓库不可用。', 'repowiki/git')
    const listed = await commitFiles(state, commit, signal)
    const rules: { base: string; matcher: Ignore }[] = []
    const ignoreFiles = listed.filter(f => /(^|\/)\.gitignore$/.test(f.path)).sort((a, b) => a.path.length - b.path.length)
    if (ignoreFiles.length > 100) throw new WikiError('Git 忽略规则文件超过 100 个，已停止扫描。', 'repowiki/ignore-limit')
    for (const file of ignoreFiles) {
      if (file.bytes > SCAN_LIMITS.maxFileBytes) throw new WikiError('.gitignore 超过读取上限，已停止扫描。', 'repowiki/ignore-limit')
      rules.push({ base: file.path.slice(0, -'.gitignore'.length), matcher: ignore().add(await readCommitFile(state, commit, file.path, signal)) })
    }
    const excluded = (path: string): boolean => {
      const parts = path.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const entry = parts.slice(0, i).join('/') + (i < parts.length ? '/' : '')
        let skipped = false
        for (const rule of rules) if (entry.startsWith(rule.base) && entry.length > rule.base.length) {
          const test = rule.matcher.test(entry.slice(rule.base.length))
          if (test.ignored) skipped = true
          if (test.unignored) skipped = false
        }
        if (skipped) return true
      }
      return false
    }
    const all = listed.filter(f => isSourcePath(f.path) && !excluded(f.path) && !(manual?.test(f.path).ignored ?? false))
    tree = all.slice(0, SCAN_LIMITS.maxEntries).map(f => f.path)
    const candidates = all.slice(0, SCAN_LIMITS.maxEntries).map(f => ({ ...f, absolute: join(root, f.path) }))
    const picked = pickExcerpts(candidates, { ...limits, maxExcerptFiles: SCAN_LIMITS.maxEntries, totalBudgetBytes: budget })
    let used = 0
    for (const file of picked) {
      signal.throwIfAborted()
      // Avoid buffering huge blobs through git show. Such files are explicitly outside the snapshot.
      if (file.bytes > (agent ? limits.maxFileBytes : 1024 * 1024)) { truncated = true; continue }
      const raw = await readCommitFile(state, commit, file.path, signal)
      const cap = Math.min(limits.maxFileBytes, budget - used)
      if (cap <= 0) { truncated = true; break }
      const text = decodeBounded(Buffer.from(raw).subarray(0, cap))
      if (text.includes('\0')) continue
      texts.push({ path: file.path, text, truncated: Buffer.byteLength(raw) > cap })
      used += Buffer.byteLength(text)
    }
    truncated ||= all.length > texts.length
  } else {
    const scan = await scanRepo(root, { ...limits, exclude }, signal)
    tree = scan.tree
    const docs = await Promise.all(scan.docs.map(async d => ({ path: d.path, absolute: join(root, d.path), bytes: await stat(join(root, d.path)).then(s => s.size).catch(() => 0) })))
    const picked = pickExcerpts([...docs, ...scan.sourceFiles], { ...limits, maxExcerptFiles: SCAN_LIMITS.maxEntries, totalBudgetBytes: budget })
    for (const file of picked) {
      signal.throwIfAborted()
      texts.push(...await readExcerpts(scan, [file], signal))
    }
    truncated = scan.treeTruncated || picked.length < docs.length + scan.sourceFiles.length
  }
  if (agent && (truncated || texts.some(f => f.truncated))) throw new WikiError('源码快照超过安全读取范围，已暂停；请用排除规则（exclude）缩小项目范围后重试。', 'repowiki/paused')
  texts = texts.filter(f => f.text.trim() && isAllowedPath(f.path))
  if (!texts.length) throw new WikiError('没有可用于生成的项目文件。', 'repowiki/empty-repo')
  const fingerprint = hash(texts.map(f => `${f.path}:${hash(f.text)}`).sort().join('\n'))
  const version = commit ?? `working-${fingerprint.slice(0, 12)}`
  const files = texts.map(file => ({ id: hash(`${version}\0${file.path}\0${file.text}`).slice(0, 32), path: file.path,
    startLine: 1, endLine: file.text.split('\n').length, hash: hash(file.text), version, text: file.text }))
  let fileStats: Record<string, { size: number; mtimeMs: number }> | undefined
  if (!commit) {
    const entries = await Promise.all(files.map(async file => {
      const info = await stat(join(root, file.path)).catch(() => null)
      return info ? [file.path, { size: info.size, mtimeMs: info.mtimeMs }] as const : null
    }))
    fileStats = Object.fromEntries(entries.filter((entry): entry is readonly [string, { size: number; mtimeMs: number }] => entry !== null))
  }
  return { root, tree, files, source: { kind: commit ? 'git' : 'working', commit: commit ?? state.commit, branch: state.branch, fingerprint }, truncated: truncated || texts.some(f => f.truncated), ...(fileStats ? { fileStats } : {}) }
}

/**
 * 工作区快速变更检测：先比对文件树与各文件 `size + mtimeMs`，
 * 全部未变化时直接返回 false，避免长任务期间每 10 秒全量读盘与 SHA-256 计算；
 * 仅当存在增删改或旧快照缺少元信息时回退到内容指纹比对。
 */
export async function hasWorkingTreeChanged(snapshot: RepositorySnapshot, exclude: readonly string[] | undefined, signal: AbortSignal): Promise<boolean> {
  if (snapshot.source.kind !== 'working') return false
  if (snapshot.fileStats) {
    const limits = { ...SCAN_LIMITS, maxFileBytes: 8 * 1024 * 1024, totalBudgetBytes: AGENT_READ_BUDGET }
    const scan = await scanRepo(snapshot.root, { ...limits, exclude }, signal)
    if (!scan.treeTruncated && scan.tree.length === snapshot.tree.length && scan.tree.every((entry, index) => entry === snapshot.tree[index])) {
      const checks = await Promise.all(Object.entries(snapshot.fileStats).map(async ([path, prev]) => {
        const info = await stat(join(snapshot.root, path)).catch(() => null)
        return !!info && info.size === prev.size && info.mtimeMs === prev.mtimeMs
      }))
      if (checks.every(Boolean)) return false
    }
  }
  const current = await captureSnapshot(snapshot.root, undefined, signal, true, exclude)
  return current.source.fingerprint !== snapshot.source.fingerprint
}

export function selectMaterial(snapshot: RepositorySnapshot, wanted: string[] = [], budget = SCAN_LIMITS.totalBudgetBytes): SourceExcerpt[] {
  const related = snapshot.files.filter(f => wanted.some(p => f.path === p || f.path.startsWith(`${p.replace(/\/$/, '')}/`)))
  const general = snapshot.files.filter(f => /(?:^|\/)(?:readme\.[^/]+|package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(f.path))
  const candidates = wanted.length ? [...related, ...general] : [...general, ...snapshot.files]
  const result: SourceExcerpt[] = []
  let used = 0
  for (const file of candidates) {
    if (result.some(f => f.path === file.path)) continue
    const remaining = budget - used
    if (remaining <= 0) break
    const raw = Buffer.from(file.text)
    const text = decodeBounded(raw.subarray(0, remaining))
    if (!text.trim()) continue
    result.push({ ...file, text, id: hash(`${file.version}\0${file.path}\0${text}`).slice(0, 32), hash: hash(text), endLine: text.split('\n').length })
    used += Buffer.byteLength(text)
  }
  return result
}

export function asMaterial(snapshot: RepositorySnapshot, files: SourceExcerpt[]): ScanMaterial {
  return { root: snapshot.root, tree: snapshot.tree, treeTruncated: snapshot.truncated, docs: [],
    excerpts: files.map(f => ({ path: f.path, text: f.text.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n'), truncated: snapshot.truncated })) }
}

export function changedSourcePaths(previous: SourceExcerpt[], current: RepositorySnapshot): Set<string> {
  const byPath = new Map(current.files.map(f => [f.path, f.hash]))
  return new Set(previous.filter(f => byPath.get(f.path) !== f.hash).map(f => f.path))
}
