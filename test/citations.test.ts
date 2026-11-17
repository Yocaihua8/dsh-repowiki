import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceExcerpt } from '../src/shared/types.js'
import { markUnverifiedCitations, parseCitations, suspiciousCitations } from '../src/host/citations.js'

const source = (path: string, startLine: number, endLine: number, text = ''): SourceExcerpt => ({
  id: `${path}:${startLine}-${endLine}`, path, startLine, endLine,
  hash: 'hash', version: 'version', text: text || Array.from({ length: endLine - startLine + 1 }, (_, i) => `line ${startLine + i}`).join('\n'),
})

test('citation parser accepts canonical, bracketed, hash and comma-separated forms', () => {
  const content = '`src/a.ts:L1-L2` `src/b.ts:12-34` `src/c.ts#L5` `src/d.ts:L7, src/e.ts:8-9`'
  const citations = parseCitations(content)
  assert.deepEqual(citations.map(c => [c.path, c.startLine, c.endLine]), [
    ['src/a.ts', 1, 2], ['src/b.ts', 12, 34], ['src/c.ts', 5, 5], ['src/d.ts', 7, 7], ['src/e.ts', 8, 9],
  ])
  assert.equal(new Set(citations.map(c => `${c.start}:${c.end}`)).size, 4)
})

test('bare citations require a known snapshot path and are ignored inside fences', () => {
  const content = 'See package.json:2-22 and src/a.ts:1-3; unknown src/missing.ts:4.\n```\npackage.json:1\n```'
  const citations = parseCitations(content, { paths: ['package.json', 'src/a.ts'], allowBare: true })
  assert.deepEqual(citations.map(c => [c.path, c.startLine, c.endLine]), [['package.json', 2, 22], ['src/a.ts', 1, 3]])
})

test('unverified marking uses merged read spans and marks one inline-code group once', () => {
  const sources = [source('src/a.ts', 1, 5), source('src/a.ts', 6, 10), source('src/b.ts', 1, 2)]
  assert.equal(markUnverifiedCitations('`src/a.ts:L4-L7`', sources, 'zh'), '`src/a.ts:L4-L7`')
  assert.equal(markUnverifiedCitations('`src/a.ts:1-10`', sources, 'zh'), '`src/a.ts:1-10`')
  assert.match(markUnverifiedCitations('`src/a.ts:L4-L12`', sources, 'zh'), /引用未核实/)
  assert.match(markUnverifiedCitations('`src/a.ts:L1,src/b.ts:L99`', sources, 'zh'), /引用未核实/)
  assert.equal(markUnverifiedCitations('src/a.ts:4-7', sources, 'zh', ['src/a.ts']), 'src/a.ts:4-7')
  assert.match(markUnverifiedCitations('missing.ts:1', sources, 'en', ['missing.ts']), /unverified/)
})

test('suspicious citations report unknown bare paths but not known or fenced ones', () => {
  const content = 'package.json:1\nsrc/unknown.ts:12\n```\nsrc/other.ts:2\n```\n`src/code.ts:L1`'
  assert.deepEqual(suspiciousCitations(content, ['package.json']), ['src/unknown.ts:12'])
})
