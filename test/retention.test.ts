import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { applyRetention, planRetention } from '../src/host/retention.js'
import { tempDir } from './helpers.js'

const wait = () => new Promise(resolve => setTimeout(resolve, 10))

test('retention keeps recent jobs/current revision and removes only planned candidates', async t => {
  const state = await tempDir(t)
  for (const id of ['job-a', 'job-b', 'job-c']) {
    await mkdir(join(state, 'jobs', id), { recursive: true })
    await writeFile(join(state, 'jobs', id, 'checkpoint.json'), '{}')
    await wait()
  }
  const wiki = join(state, 'wikis', 'wiki-a')
  for (const id of ['rev-current', 'rev-old-1', 'rev-old-2']) {
    await mkdir(join(wiki, 'revisions', id), { recursive: true })
    await writeFile(join(wiki, 'revisions', id, 'page.md'), id)
    await wait()
  }
  await writeFile(join(wiki, 'manifest.json'), JSON.stringify({ revision: 'rev-current' }))
  const plan = await planRetention(state, { keepJobs: 1, keepRevisions: 1, olderThanDays: 0 })
  assert.equal(plan.jobs, 2)
  assert.equal(plan.revisions, 1)
  assert.ok(plan.candidates.some(item => item.kind === 'job' && item.id === 'job-a'))
  assert.ok(plan.candidates.some(item => item.kind === 'revision' && item.id === 'rev-old-1'))
  assert.ok(!plan.candidates.some(item => item.id === 'job-c' || item.id === 'rev-current'))
  await applyRetention(state, plan)
  assert.equal(existsSync(join(state, 'jobs', 'job-c')), true)
  assert.equal(existsSync(join(state, 'jobs', 'job-a')), false)
  assert.equal(existsSync(join(wiki, 'revisions', 'rev-current')), true)
  assert.equal(existsSync(join(wiki, 'revisions', 'rev-old-1')), false)
})

test('retention refuses invalid candidate identifiers', async t => {
  const state = await tempDir(t)
  await assert.rejects(applyRetention(state, { jobs: 0, revisions: 0, bytes: 0, candidates: [{ kind: 'job', id: '../outside', bytes: 1, at: 0 }] }), /标识无效/)
})
