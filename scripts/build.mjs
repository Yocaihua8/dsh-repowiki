/**
 * 构建：Typert RPC 工件 + Host ESM bundle + 浏览器 CJS bundle + Mermaid 懒加载 chunk + 两份声明。
 * 模式与 dsh-prompt-improver 的 build-plugin.mjs 一致（无 shared 契约同步）。
 */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export async function buildPlugin(entryUrl) {
  const root = fileURLToPath(new URL('../', entryUrl))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const require = createRequire(join(root, 'package.json'))
  const { build } = await import(pathToFileURL(require.resolve('esbuild')).href)
  const { WorkspaceAnalyzer, FaceModelEmitter, writeWorkspaceArtifacts } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-generator')).href)
  // The official generator needs a packages/ workspace and protocol source identity.
  const workspace = join(root, '.cache/typert')
  const staged = join(workspace, 'packages/plugin')
  const protocol = join(workspace, 'packages/protocol')
  await cp(dirname(require.resolve('@deepseek-ai/dsh-typert-protocol/package.json')), protocol, { recursive: true })
  for (const entry of await readdir(join(protocol, 'lib/types'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue
    const source = join(entry.parentPath, entry.name)
    const target = source.replace(join(protocol, 'lib/types'), join(protocol, 'src')).replace(/\.d\.ts$/, '.ts')
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target)
  }
  await mkdir(staged, { recursive: true })
  await cp(join(root, 'src'), join(staged, 'src'), { recursive: true })
  const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))
  config.include = ['src/index.ts', 'src/host/**/*.ts', 'src/shared/**/*.ts']
  config.compilerOptions.allowImportingTsExtensions = true
  config.compilerOptions.lib.push('ESNext.Disposable')
  config.compilerOptions.paths = { '@deepseek-ai/dsh-typert-protocol': [join(protocol, 'src/index.ts')] }
  await writeFile(join(protocol, 'tsconfig.json'), JSON.stringify({ compilerOptions: config.compilerOptions, include: ['src/**/*.ts'] }, null, 2))
  const hostManifest = structuredClone(manifest)
  delete hostManifest.exports['./client']
  await writeFile(join(staged, 'package.json'), JSON.stringify(hostManifest, null, 2))
  await writeFile(join(staged, 'tsconfig.json'), JSON.stringify(config, null, 2))
  await writeFile(join(workspace, 'tsconfig.host.json'), JSON.stringify({
    ...config, files: [], include: [], references: [{ path: './packages/plugin/tsconfig.json' }, { path: './packages/protocol/tsconfig.json' }],
  }, null, 2))
  const model = new WorkspaceAnalyzer({ root: workspace, packages: [manifest.name], faces: ['host'] }).analyze()
  const artifacts = model.faces.flatMap(face => face.packages.map(pkg => ({
    ...new FaceModelEmitter(face).emit(pkg.name), packageRoot: pkg.root,
  })))
  if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Expected one generated Host and Remote contribution')
  writeWorkspaceArtifacts(workspace, artifacts)
  await mkdir(join(root, 'lib'), { recursive: true })
  for (const name of ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts']) {
    await cp(join(staged, 'lib', name), join(root, 'lib', name))
  }
  await build({
    absWorkingDir: root, entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true,
    platform: 'node', format: 'esm', target: 'es2023', packages: 'external',
  })
  await build({
    absWorkingDir: root, entryPoints: ['src/shared/types.ts'], outfile: 'lib/shared/types.js',
    bundle: true, packages: 'external', format: 'esm', platform: 'neutral',
  })
  await build({
    absWorkingDir: root, entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true,
    platform: 'browser', format: 'cjs', target: 'es2022', loader: { '.css': 'text' },
    external: ['react', 'react/jsx-runtime', 'react-dom', 'zod', '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-api-gateway/client',
      '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-renderer'],
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
    footer: { js: 'return module.exports; }});' },
  })
  // Mermaid 是体积较大的可选能力：单独打成 package-local chunk，首次遇到图表时由
  // require.async('./client.mermaid.js') 懒加载，不增加面板初始 bundle。
  await build({
    absWorkingDir: root, entryPoints: ['src/client/mermaid-runtime.ts'], outfile: 'lib/client.mermaid.js', bundle: true,
    platform: 'browser', format: 'cjs', target: 'es2022', minify: true, legalComments: 'eof',
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, chunk: 'client.mermaid.js', factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
    footer: { js: 'return module.exports; }});' },
  })
  // 宿主声明输出在 lib/types；为 lib/shared/types.js 补一个转发 shim，供 ./types 导出与生成产物解析。
  await writeFile(join(root, 'lib/shared/types.d.ts'), "export * from '../types/shared/types.js'\n")
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--emitDeclarationOnly'], { cwd: root, stdio: 'inherit' })
  // Emit client declarations separately so shared declaration inputs are not overwritten.
  const clientDeclarations = join(root, '.cache/client-declarations')
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.client.json', '--emitDeclarationOnly', '--outDir', clientDeclarations], { cwd: root, stdio: 'inherit' })
  await cp(join(clientDeclarations, 'client'), join(root, 'lib/types/client'), { recursive: true })
  console.log(`${manifest.name}: built Host, browser module, declarations, and Typert RPC artifacts.`)
}

await buildPlugin(import.meta.url)
