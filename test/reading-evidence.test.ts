import test from 'node:test'
import assert from 'node:assert/strict'
import { citedFiles, sourceLabel, readingCitations } from '../src/client/reading-evidence.js'

test('short visible references resolve to exact original paths and preserve code and export text', () => {
  const paths=['src/host/index.ts','src/client/index.ts']
  const body='A `src/host/index.ts:L4-L8`.\n\n```ts\n`src/client/index.ts:L4`\n```\n\nB `src/client/index.ts:L9`.'
  const result=readingCitations(body,paths)
  assert.ok(result.text.includes('`host/index.ts:L4-L8`'))
  assert.ok(result.text.includes('```ts\n`src/client/index.ts:L4`\n```'))
  assert.equal(result.originals.get('host/index.ts:L4-L8'),'src/host/index.ts:L4-L8')
  assert.equal(result.originals.get('client/index.ts:L9'),'src/client/index.ts:L9')
  assert.ok(body.startsWith('A `src/host/index.ts:L4-L8`.'))
})

test('reference labels distinguish identical basenames without changing source identities', () => {
  const paths=['src/client/index.ts','src/host/index.ts','README.md']
  assert.equal(sourceLabel(paths[0],paths),'client/index.ts')
  assert.equal(sourceLabel(paths[1],paths),'host/index.ts')
  assert.equal(sourceLabel(paths[2],paths),'README.md')
  const sources=[{id:'a',path:paths[0],startLine:1,endLine:20},{id:'b',path:paths[1],startLine:1,endLine:20}]
  assert.deepEqual(citedFiles('`src/client/index.ts:L2-L4` and `src/client/index.ts:L8`',sources),[sources[0]])
  assert.deepEqual(citedFiles('```ts\n`src/host/index.ts:L2`\n```\n\n`src/client/index.ts:L99`',sources),[])
  assert.equal(sources[0].path,'src/client/index.ts')
})
