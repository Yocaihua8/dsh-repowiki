import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { exportJournalPath, exportWiki, recoverExportJournal } from '../src/host/exporter.js'
import { writeWiki } from '../src/host/store.js'
import { makeRepo, tempDir } from './helpers.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const manifest = (repo: string) => ({ id: 'journal-wiki', repoPath: repo, title: 'Journal Wiki', description: '', language: 'zh' as const, createdAt: '', updatedAt: '', generator: 'dsh-repowiki' })

test('successful export leaves no recovery journal', async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  const saved = await writeWiki(state, manifest(repo), [{ id: 'overview', title: 'Overview', summary: '', related: [], content: '# Old' }])
  await exportWiki(state, saved)
  assert.equal(existsSync(exportJournalPath(state, saved)), false)
})

test('recovery restores files when an export was interrupted after rename', async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  const saved = await writeWiki(state, manifest(repo), [{ id: 'overview', title: 'Overview', summary: '', related: [], content: '# Old' }])
  const result = await exportWiki(state, saved)
  const journalDir = exportJournalPath(state, saved), target = join(result.directory, 'page-overview.md')
  const original = await readFile(target, 'utf8'), next = '# New after crash'
  await writeFile(target, next, 'utf8')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(journalDir, { recursive: true })
  await writeFile(join(journalDir, '0.bak'), original, 'utf8')
  await writeFile(join(journalDir, 'journal.json'), JSON.stringify({ version: 1, directory: result.directory,
    entries: [{ file: 'page-overview.md', originalHash: digest(original), newHash: digest(next), backup: '0.bak' }] }))
  await recoverExportJournal(journalDir)
  assert.equal(await readFile(target, 'utf8'), original)
  assert.equal(existsSync(journalDir), false)
})

test('recovery refuses to overwrite a user edit made after the crash', async t => {
  const repo = await makeRepo(t), state = await tempDir(t)
  const saved = await writeWiki(state, manifest(repo), [{ id: 'overview', title: 'Overview', summary: '', related: [], content: '# Old' }])
  const result = await exportWiki(state, saved)
  const journalDir = exportJournalPath(state, saved), target = join(result.directory, 'page-overview.md')
  const original = await readFile(target, 'utf8')
  await writeFile(target, '# User edit', 'utf8')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(journalDir, { recursive: true })
  await writeFile(join(journalDir, '0.bak'), original, 'utf8')
  await writeFile(join(journalDir, 'journal.json'), JSON.stringify({ version: 1, directory: result.directory,
    entries: [{ file: 'page-overview.md', originalHash: digest(original), newHash: digest('# crashed write'), backup: '0.bak' }] }))
  await assert.rejects(recoverExportJournal(journalDir), /文件被修改/)
  assert.equal(await readFile(target, 'utf8'), '# User edit')
  assert.equal(existsSync(journalDir), true)
})
