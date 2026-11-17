// Isolated real-host loading probe / interactive acceptance server. Never prints credentials.
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const [runtime, home, profile, report, port = '5495', repository, mode = 'probe'] = process.argv.slice(2)
if (!runtime || !home || !profile || !report) throw new Error('runtime home profile report [port] [repository] [serve|probe] required')
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
process.env.DSH_AGENTS_HOME = `${home}/agents`
const load = name => import(pathToFileURL(`${runtime}/node_modules/@deepseek-ai/${name}/lib/index.js`))
const { loadProfileDirectory } = await load('dsh-app-boot')
const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment')
const { runProfile } = await import(pathToFileURL(`${runtime}/node_modules/@deepseek-ai/dsh/lib/profile-boot.js`))
const installAnchor = `${runtime}/node_modules/@deepseek-ai/dsh/package.json`
const overlay = `${home}/acceptance.patch.yml`
const mark = stage => fs.appendFile(`${report}.steps`, `${new Date().toISOString()} ${stage}\n`)
await fs.writeFile(overlay, '- id: hmr\n  disabled: true\n')
const resolved = loadProfileDirectory('dsh', `${home}/profiles/${profile}`, installAnchor)
await mark('profile composed')
let ctx
const timeout = setTimeout(() => { console.error('Host startup timeout'); process.exit(2) }, 60000)
try {
  const result = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]), profile,
    resolvedProfile: { profile: resolved, installAnchor }, patchFiles: [overlay], args: ['--host', '127.0.0.1', '--port', port, '--no-open'] })
  await mark('runProfile returned')
  ctx = result.ctx; await ctx.get('loader').await()
  await mark('loader settled')
  const service = ctx.get('repowiki')
  if (!service) {
    await fs.writeFile(report, JSON.stringify({ serviceAvailable: false, skipped: resolved.skippedBundles,
      entries: [...ctx.get('loader').entries()].filter(e => e.options.name === 'dsh-repowiki' || e.fiber?.state === 4).map(e => ({ name: e.options.name, state: e.fiber?.state, disabled: e.disabled, error: String(e.fiber?.error ?? '') })) }, null, 2))
    throw new Error('RepoWiki service missing')
  }
  if (repository) await ctx.get('workspaceRegistry').create(repository, 'RepoWiki isolated acceptance')
  if (repository) await fs.writeFile(`${report}.configuration.json`, JSON.stringify(await service.pipeline.configuration(repository), null, 2))
  const entries = [...ctx.get('loader').entries()].filter(e => e.options.name === 'dsh-repowiki').map(e => ({ id: e.id, state: e.fiber?.state, disabled: e.disabled }))
  const errors = [...ctx.get('loader').entries()].filter(e => e.fiber?.state === 4).map(e => e.options.name)
  const record = { runtimeVersion: JSON.parse(await fs.readFile(installAnchor, 'utf8')).version, rootState: ctx.fiber.state, entries, errors,
    pluginVersion: JSON.parse(await fs.readFile(`${home}/profiles/${profile}/node_modules/dsh-repowiki/package.json`, 'utf8')).version, serviceAvailable: !!service, skipped: resolved.skippedBundles,
    providers: ctx.get('llm').listProviders().map(p => ({ id: p.id, name: p.name })), defaultModel: ctx.get('agentDefaultModel').currentSelection() }
  await fs.writeFile(report, JSON.stringify(record, null, 2))
  if (record.rootState !== 2 || errors.length || !entries.some(e => e.state === 2)) throw new Error('Host did not fully activate RepoWiki')
  clearTimeout(timeout)
  console.log(JSON.stringify(record))
  if (mode === 'serve') {
    // Local, explicit acceptance commands; no network endpoint and no arbitrary code execution.
    let processing = false
    await new Promise(resolve => {
      const timer = setInterval(async () => {
        if (processing) return
        processing = true
        try {
          await service.pipeline.ready
          await fs.writeFile(`${report}.jobs.json`, JSON.stringify(service.pipeline.statuses(), null, 2))
          const commandFile = `${report}.command.json`
          const command = await fs.readFile(commandFile, 'utf8').then(JSON.parse).catch(() => null)
          if (command) {
            await fs.unlink(commandFile)
            let value
            try {
              if (command.op === 'models') {
                value = []
                for (const provider of ctx.get('llm').listProviders()) value.push({ provider: provider.id, models: await ctx.get('llm').listModels(provider.id) })
              } else if (command.op === 'inspectSession') {
                const { SessionId } = await load('dsh-session')
                const observation = await ctx.get('sessionQuery').observeSession(SessionId(command.sessionId), { signal: AbortSignal.timeout(10000), projectionMode: 'none' })
                try {
                  value = { sessionId: command.sessionId, eventCount: observation.events.length,
                    messageSources: observation.events.filter(e => e.type === 'user/message').map(e => ({ seq: e.seq, kind: e.data.source?.kind, form: e.data.source?.form, principal: e.data.source?.principal?.kind })),
                    agents: ctx.get('agents').roots().filter(a => a.id === command.sessionId).map(a => ({ id: a.id, cwd: a.session.header.cwd, origin: a.session.header.origin, parent: a.session.header.parentSession, delegationDepth: a.session.header.delegationDepth, policyRoot: a.ctx.get('sandboxPolicy').resolve({ session: a.session }).workspaceRoot })),
                    contextEvidence: observation.events.filter(e => {
                    const text = JSON.stringify(e); return text.includes('dsh-repowiki:cards') || text.includes('项目知识卡片（仅供参考')
                  }).map(e => { const text = JSON.stringify(e); return { type: e.type, seq: e.seq, hasCard: text.includes('项目知识卡片（仅供参考'), hasGuide: text.includes('docs/guide.md:L11'), hasReadme: text.includes('README.md:L91') } }) }
                } finally { observation[Symbol.dispose]() }
              } else if (command.op === 'configure') value = await service.pipeline.saveSettings(repository, { ...(await service.pipeline.configuration(repository)).settings, ...command.settings })
              else if (command.op === 'start') value = await service.pipeline.start({ repoPath: repository, mode: command.mode })
              else if (command.op === 'pause') value = await service.pipeline.pause(command.jobId)
              else if (command.op === 'resume') value = await service.pipeline.resume(command.jobId)
              else if (command.op === 'cancel') value = service.pipeline.cancel(command.jobId)
              else if (command.op === 'export') value = await service.pipeline.export(command.wikiId)
              else if (command.op === 'draft') value = await service.pipeline.draft(command.jobId)
              else throw new Error('Unsupported acceptance command')
              await fs.writeFile(`${report}.response.json`, JSON.stringify({ id: command.id, ok: true, value }, null, 2))
            } catch (error) { await fs.writeFile(`${report}.response.json`, JSON.stringify({ id: command.id, ok: false, message: error.message }, null, 2)) }
          }
          if (await fs.stat(`${report}.stop`).catch(() => null)) { clearInterval(timer); resolve() }
        } finally { processing = false }
      }, 2000)
    })
  }
} finally { clearTimeout(timeout); if (ctx) await ctx.fiber.dispose() }
