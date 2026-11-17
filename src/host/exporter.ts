import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExportResponse, WikiManifest } from '../shared/types.js'
import { WikiError } from './errors.js'
import { readPageContent } from './store.js'
import { atomicJson } from './settings.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const META = '.repowiki-export.json'
interface ExportRecord { wikiId: string; revision: string | null; files: Record<string, string> }
interface JournalEntry { file: string; originalHash: string | null; newHash: string | null; backup: string | null }
interface ExportJournal { version: 1; directory: string; entries: JournalEntry[] }
export const exportJournalPath = (stateDir: string, wiki: WikiManifest): string => join(stateDir, 'exports', `${wiki.id}-${wiki.language}.journal`)
const MANAGED_EXPORT_FILE = (file: string): boolean => file === META || file === 'knowledge-cards.json' || /^(README|(?:page-)?[a-z0-9][a-z0-9-]{0,63})\.md$/.test(file)
/** Recover an interrupted export before starting a new one. */
export async function recoverExportJournal(journalDir: string): Promise<void> {
  let raw: string
  try { raw = await readFile(join(journalDir, 'journal.json'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await rm(journalDir, { recursive: true, force: true }).catch(() => {}); return }
    throw error
  }
  let journal: ExportJournal
  try { journal = JSON.parse(raw) as ExportJournal } catch { throw new WikiError('导出恢复日志损坏，未覆盖现有文件。', 'repowiki/export-conflict') }
  if (journal?.version !== 1 || typeof journal.directory !== 'string' || !Array.isArray(journal.entries)) throw new WikiError('导出恢复日志无效，未覆盖现有文件。', 'repowiki/export-conflict')
  for (const entry of journal.entries) {
    if (!entry || typeof entry.file !== 'string' || !MANAGED_EXPORT_FILE(entry.file)
      || !(entry.originalHash === null || typeof entry.originalHash === 'string')
      || !(entry.newHash === null || typeof entry.newHash === 'string')
      || !(entry.backup === null || typeof entry.backup === 'string')) throw new WikiError('导出恢复日志含无效条目，未覆盖现有文件。', 'repowiki/export-conflict')
    const target = join(journal.directory, entry.file)
    const current = await textOrNull(target)
    const currentHash = current === null ? null : digest(current)
    if (currentHash === entry.originalHash) continue
    if (currentHash !== entry.newHash) throw new WikiError(`导出恢复发现文件被修改：${entry.file}`, 'repowiki/export-conflict')
    if (entry.originalHash === null) { await unlink(target).catch(() => {}) ; continue }
    if (!entry.backup) throw new WikiError(`导出恢复缺少原文件备份：${entry.file}`, 'repowiki/export-conflict')
    const original = await readFile(join(journalDir, entry.backup), 'utf8').catch(() => null)
    if (original === null || digest(original) !== entry.originalHash) throw new WikiError(`导出恢复备份损坏：${entry.file}`, 'repowiki/export-conflict')
    await writeFile(target, original, 'utf8')
  }
  await rm(journalDir, { recursive: true, force: true })
}
async function noLink(path: string): Promise<void> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null })
  if (stat?.isSymbolicLink()) throw new WikiError(`导出路径含符号链接：${path}`, 'repowiki/export-conflict')
}
async function textOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null })
}
/** Preflight every managed file before any replacement. Unknown files are never removed. */
export async function exportWiki(stateDir: string, wiki: WikiManifest): Promise<ExportResponse> {
  if (!['zh', 'en'].includes(wiki.language)) throw new WikiError('旧版 Wiki 语言不支持自动导出，请重新生成。', 'repowiki/export-language')
  const journalDir = exportJournalPath(stateDir, wiki)
  await recoverExportJournal(journalDir)
  let directory = wiki.repoPath
  for (const segment of ['.dsh', 'repowiki', wiki.language]) {
    directory = join(directory, segment)
    await noLink(directory)
  }
  await mkdir(directory, { recursive: true })
  await noLink(join(directory, META))
  const oldMeta = await textOrNull(join(directory, META))
  const receiptPath = join(stateDir, 'exports', `${wiki.id}-${wiki.language}.json`)
  const receipt = await textOrNull(receiptPath)
  if (oldMeta !== null) {
    let expected: string | undefined
    try { expected = receipt ? (JSON.parse(receipt) as { metadataHash: string }).metadataHash : undefined } catch { /* Invalid receipts fail closed. */ }
    if (!expected || digest(oldMeta) !== expected) throw new WikiError('导出元信息已修改或缺少管理记录，未覆盖现有文件。', 'repowiki/export-conflict')
  } else if (receipt !== null) throw new WikiError('导出元信息已被删除，未覆盖现有文件。', 'repowiki/export-conflict')
  let previous: ExportRecord | null = null
  try { previous = oldMeta === null ? null : JSON.parse(oldMeta) as ExportRecord } catch { throw new WikiError('导出元信息已修改或损坏。', 'repowiki/export-conflict') }
  if (previous && (previous.wikiId !== wiki.id || !previous.files || Object.keys(previous.files).some(p => p !== 'knowledge-cards.json' && !/^(README|(?:page-)?[a-z0-9][a-z0-9-]{0,63})\.md$/.test(p)))) {
    throw new WikiError('导出目录不属于此 Wiki 或元信息无效。', 'repowiki/export-conflict')
  }
  const output = new Map<string, string>()
  if (wiki.cards) output.set('knowledge-cards.json', JSON.stringify({ revision: wiki.revision, source: wiki.source, cards: wiki.cards }, null, 2))
  const depth = (id: string): number => {
    const seen = new Set<string>(); let current = wiki.pages.find(p => p.id === id); let level = 0
    while (current?.parentId && !seen.has(current.id)) { seen.add(current.id); current = wiki.pages.find(p => p.id === current?.parentId); level++ }
    return level
  }
  output.set('README.md', `# ${wiki.title}\n\n${wiki.description}\n\n${wiki.pages.map(p => `${'  '.repeat(depth(p.id))}- ${p.kind === 'group' ? p.title : `[${p.title.replace(/[\[\]]/g, '')}](page-${p.id}.md)`}`).join('\n')}\n`)
  for (const page of wiki.pages.filter(p => p.kind !== 'group')) {
    const body = await readPageContent(stateDir, wiki.id, page.id, wiki)
    if (body === null) throw new WikiError('页面缺失，导出中止。', 'repowiki/export-missing')
    output.set(`page-${page.id}.md`, body)
  }
  const originals = new Map<string, string | null>()
  for (const file of new Set([...Object.keys(previous?.files ?? {}), ...output.keys()])) {
    await noLink(join(directory, file))
    const current = await textOrNull(join(directory, file))
    originals.set(file, current)
    const expected = previous?.files[file]
    if (expected ? current === null || digest(current) !== expected : current !== null) {
      throw new WikiError(`检测到人工修改或同名文件，未覆盖：${file}`, 'repowiki/export-conflict')
    }
  }
  const record: ExportRecord = { wikiId: wiki.id, revision: wiki.revision ?? null, files: Object.fromEntries([...output].map(([name, text]) => [name, digest(text)])) }
  originals.set(META, oldMeta)
  output.set(META, JSON.stringify({ ...record, source: wiki.source, model: wiki.model, updatedAt: wiki.updatedAt, pages: wiki.pages }, null, 2))
  const temporary: string[] = []
  const changed: string[] = []
  const staged: Array<{ file: string; temp: string; target: string }> = []
  let journalCreated = false
  try {
    await mkdir(journalDir, { recursive: true })
    const entries: JournalEntry[] = []
    for (const file of new Set([...output.keys(), ...originals.keys()])) {
      const original = originals.get(file) ?? null, next = output.get(file) ?? null
      if (original === next) continue
      const backup = original === null ? null : `${entries.length}.bak`
      if (backup) await writeFile(join(journalDir, backup), original!, 'utf8')
      entries.push({ file, originalHash: original === null ? null : digest(original), newHash: next === null ? null : digest(next), backup })
    }
    await atomicJson(join(journalDir, 'journal.json'), { version: 1, directory, entries } satisfies ExportJournal)
    journalCreated = true
    // Stage every file before touching the export directory. A write failure
    // leaves existing exported files unchanged.
    for (const [file, body] of output) {
      const target = join(directory, file)
      if (await textOrNull(target) !== originals.get(file)) throw new WikiError(`导出期间文件被修改：${file}`, 'repowiki/export-conflict')
      const temp = join(directory, `.repowiki-${randomUUID()}.tmp`)
      temporary.push(temp)
      await writeFile(temp, body, 'utf8')
      staged.push({ file, temp, target })
    }
    // Recheck after all staging work, preserving edits made while export was preparing.
    for (const { file, target } of staged) if (await textOrNull(target) !== originals.get(file)) throw new WikiError(`导出期间文件被修改：${file}`, 'repowiki/export-conflict')
    for (const { file, temp, target } of staged) { await rename(temp, target); changed.push(file) }
    for (const file of originals.keys()) if (!output.has(file)) {
      if (await textOrNull(join(directory, file)) !== originals.get(file)) throw new WikiError(`导出期间文件被修改：${file}`, 'repowiki/export-conflict')
      await unlink(join(directory, file)); changed.push(file)
    }
    await atomicJson(receiptPath, { metadataHash: digest(output.get(META)!), directory, revision: wiki.revision })
    await rm(journalDir, { recursive: true, force: true }).catch(() => {})
    journalCreated = false
  } catch (error) {
    let rolledBack = true
    for (const file of changed.reverse()) {
      try {
        const current = await textOrNull(join(directory, file))
        if (output.has(file) ? current !== output.get(file) : current !== null) continue // Do not roll back an edit made by the user meanwhile.
        const original = originals.get(file)
        if (original === null || original === undefined) await unlink(join(directory, file)).catch(() => {})
        else await writeFile(join(directory, file), original, 'utf8')
      } catch { rolledBack = false }
    }
    if (rolledBack && journalCreated) await rm(journalDir, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    for (const temp of temporary) await unlink(temp).catch(() => {})
  }
  return { directory, files: output.size }
}
