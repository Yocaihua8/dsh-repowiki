import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { relative, resolve } from 'node:path'
import { WikiError } from './errors.js'

const exec = promisify(execFile)
export async function git(path: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await exec('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, signal })
  return result.stdout
}
export interface GitState { available: boolean; branch: string | null; commit: string | null; root: string; prefix: string }
export async function gitState(path: string, signal?: AbortSignal): Promise<GitState> {
  try {
    const root = (await git(path, ['rev-parse', '--show-toplevel'], signal)).trim()
    const commit = (await git(path, ['rev-parse', '--verify', 'HEAD'], signal)).trim()
    const branch = (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal).catch(() => '')).trim() || null
    return { available: /^[a-f0-9]{40,64}$/.test(commit), root, prefix: relative(root, resolve(path)).replaceAll('\\', '/'), commit, branch }
  } catch (error) { signal?.throwIfAborted(); return { available: false, root: path, prefix: '', commit: null, branch: null } }
}
export async function commitFiles(state: GitState, commit: string, signal?: AbortSignal): Promise<{ path: string; bytes: number }[]> {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new WikiError('提交标识无效。', 'repowiki/git')
  const output = await git(state.root, ['ls-tree', '-rlz', '--full-tree', commit], signal)
  const prefix = state.prefix ? `${state.prefix}/` : ''
  return output.split('\0').flatMap(line => {
    const match = /^(100644|100755) blob [a-f0-9]+\s+(\d+)\t([\s\S]+)$/.exec(line)
    if (!match || !match[3]!.startsWith(prefix)) return []
    return [{ path: match[3]!.slice(prefix.length), bytes: Number(match[2]) }]
  })
}
export async function readCommitFile(state: GitState, commit: string, path: string, signal?: AbortSignal): Promise<string> {
  if (!/^[a-f0-9]{40,64}$/.test(commit) || path.startsWith('/') || path.split(/[\\/]/).some(p => p === '..' || p === '.')) throw new WikiError('源码路径无效。', 'repowiki/path')
  const object = `${commit}:${state.prefix ? `${state.prefix}/` : ''}${path}`
  return await git(state.root, ['show', object], signal)
}
