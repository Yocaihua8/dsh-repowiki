/**
 * 有界仓库扫描 — 只读。
 *
 * 产出三部分，全部带硬上限：文件树、说明文档（README/包清单）、代表性源码摘录。
 * 仓库目录在扫描中绝不被写入。
 */
import { readdir, stat, open, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, posix, relative, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { WikiError } from './errors.js'

export const SCAN_LIMITS = Object.freeze({
  /** 单次扫描纳入文件树的条目硬上限；与 Qoder Repo Wiki 的 10,000 文件口径一致。 */
  maxEntries: 10_000,
  maxDepth: 12,
  maxFileBytes: 64 * 1024,
  totalBudgetBytes: 240 * 1024,
  maxExcerptFiles: 24,
  /** 手工排除规则数量上限（.gitignore 语法）。 */
  maxExcludeRules: 200,
})

export interface ScanDoc { path: string; text: string; truncated: boolean }
export interface ScanSourceFile { path: string; absolute: string; bytes: number }
export interface ScanExcerptFile extends ScanSourceFile { capBytes: number }
export interface ScanExcerpt { path: string; text: string; truncated: boolean }
export interface ScanResult {
  sourceFiles: ScanSourceFile[]
  root: string
  tree: string[]
  treeTruncated: boolean
  docs: ScanDoc[]
  /** 代表性源码文件引用（未读取文本）。 */
  excerpts: ScanExcerptFile[]
  stats: { entries: number; docFiles: number; sourceCandidates: number }
}
/** 供提示词使用的材料：摘录已读取文本。 */
export interface ScanMaterial {
  root: string
  tree: string[]
  treeTruncated: boolean
  docs: ScanDoc[]
  excerpts: ScanExcerpt[]
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'output', 'target',
  '.venv', 'venv', 'env', '__pycache__', '.idea', '.vscode', '.gradle', 'coverage',
  '.next', '.nuxt', '.svelte-kit', 'vendor', 'bundles', 'deps', '_build', 'Pods',
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.svgz',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.br', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.msi', '.apk', '.jar', '.war',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg',
  '.wasm', '.node', '.bin', '.dat', '.db', '.sqlite', '.pyc', '.class', '.o', '.obj', '.lib', '.a',
])

const DOC_FILES = ['readme.md', 'readme.txt', 'readme.rst', 'readme']
const MANIFEST_FILES = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py',
  'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'composer.json', 'gemfile', 'mix.exs', 'cabal.project', 'meson.build', 'makefile', 'cmakelists.txt',
])

const EXCERPT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.m', '.mm',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.hh', '.cs', '.rb', '.php', '.dart', '.scala', '.groovy',
  '.vue', '.svelte', '.astro', '.sql', '.sh', '.bash', '.ps1', '.lua', '.ex', '.exs', '.erl', '.zig', '.proto', '.graphql',
  '.yml', '.yaml', '.toml', '.json', '.md',
])

export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.github' && name !== '.gitlab')
}

/** 广度优先遍历，按浅层优先收集；超过 maxEntries 立即截断。 */
export type ScanLimits = { [K in keyof typeof SCAN_LIMITS]: number }
/** 扫描选项：数值预算 + 手工排除规则（.gitignore 语法）。 */
export interface ScanOptions extends Partial<ScanLimits> { exclude?: readonly string[] }

/** 把手工排除规则编译成匹配器；空规则返回 null，调用方无需分支。 */
export function excludeMatcher(rules: readonly string[] | undefined): Ignore | null {
  const patterns = (rules ?? []).map(rule => rule.trim()).filter(rule => rule !== '' && !rule.startsWith('#'))
  if (!patterns.length) return null
  if (patterns.length > SCAN_LIMITS.maxExcludeRules) throw new WikiError(`排除规则超过 ${SCAN_LIMITS.maxExcludeRules} 条上限。`, 'repowiki/exclude-limit')
  try { return ignore().add(patterns) } catch (error) { throw new WikiError('排除规则无效，请使用 .gitignore 语法。', 'repowiki/exclude-invalid', error) }
}

export async function scanRepo(root: string, overrides: ScanOptions = {}, signal?: AbortSignal): Promise<ScanResult> {
  signal?.throwIfAborted()
  const { exclude, ...budgets } = overrides
  const limits = { ...SCAN_LIMITS, ...budgets }
  const manual = excludeMatcher(exclude)
  /** 手工排除对该条目是否生效；目录带尾斜杠，与 .gitignore 语义一致。 */
  const manuallyExcluded = (relativePath: string, isDirectory: boolean): boolean =>
    manual !== null && manual.test(isDirectory ? `${relativePath}/` : relativePath).ignored
  let rootStat
  try { rootStat = await stat(root) } catch {
    throw new WikiError(`仓库路径不存在或不可访问：${root}`, 'repowiki/path-not-found')
  }
  if (!rootStat.isDirectory()) throw new WikiError(`仓库路径不是目录：${root}`, 'repowiki/not-a-directory')

  const tree: string[] = []
  const docs: (ScanDoc | null)[] = []
  const sourceFiles: ScanSourceFile[] = []
  let truncated = false
  let docBytes = 0
  let depth = 0
  let level = [root]
  const rules = new Map<string, { dir: string; matcher: Ignore }[]>()

  while (level.length > 0 && tree.length < limits.maxEntries) {
    signal?.throwIfAborted()
    const next: string[] = []
    for (const dir of level) {
      if (tree.length >= limits.maxEntries) break
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      const inherited = [...(rules.get(dirname(dir)) ?? [])]
      const ignoreFile = await readDoc(join(dir, '.gitignore'), '.gitignore', SCAN_LIMITS.maxFileBytes)
      if (ignoreFile?.truncated) throw new WikiError('.gitignore 超过读取上限，已停止扫描以避免遗漏忽略规则。', 'repowiki/ignore-limit')
      const patterns = ignoreFile?.text ?? ''
      if (patterns) inherited.push({ dir, matcher: ignore().add(patterns) })
      rules.set(dir, inherited)
      for (const entry of entries) {
        signal?.throwIfAborted()
        if (tree.length >= limits.maxEntries) { truncated = true; break }
        const relativePath = relative(root, join(dir, entry.name)).split(sep).join(posix.sep)
        let ignored = false
        for (const rule of inherited) {
          const decision = rule.matcher.test(relative(rule.dir, join(dir, entry.name)).split(sep).join('/') + (entry.isDirectory() ? '/' : ''))
          if (decision.ignored) ignored = true
          if (decision.unignored) ignored = false
        }
        if (ignored || (entry.isDirectory() ? shouldSkipDir(entry.name) : !isAllowedPath(relativePath))) continue
        if (manuallyExcluded(relativePath, entry.isDirectory())) continue
        if (entry.isDirectory()) {
          if (shouldSkipDir(entry.name)) continue
          tree.push(`${relativePath}/`)
          if (depth + 1 < limits.maxDepth) next.push(join(dir, entry.name))
          else truncated = true
          continue
        }
        if (!entry.isFile()) continue
        const ext = extname(entry.name).toLowerCase()
        if (BINARY_EXTENSIONS.has(ext)) continue
        tree.push(relativePath)
        const lowerBase = entry.name.toLowerCase()
        if (docs.length < 12 && (DOC_FILES.includes(lowerBase) || MANIFEST_FILES.has(lowerBase))) {
          const doc = await readDoc(join(dir, entry.name), relativePath, Math.min(limits.maxFileBytes, Math.max(0, limits.totalBudgetBytes - docBytes)))
          docs.push(doc)
          docBytes += doc ? Buffer.byteLength(doc.text) : 0
          continue
        }
        if (isSourcePath(relativePath)) {
          const size = await stat(join(dir, entry.name)).then(s => s.size).catch(() => 0)
          sourceFiles.push({ path: relativePath, absolute: join(dir, entry.name), bytes: size })
        }
      }
      if (tree.length >= limits.maxEntries) truncated = true
    }
    level = next
    depth += 1
  }

  return {
    root,
    sourceFiles,
    tree,
    treeTruncated: truncated,
    docs: docs.filter((doc): doc is ScanDoc => doc !== null),
    excerpts: pickExcerpts(sourceFiles, { ...limits, totalBudgetBytes: Math.max(0, limits.totalBudgetBytes - docBytes) }),
    stats: { entries: tree.length, docFiles: docs.length, sourceCandidates: sourceFiles.length },
  }
}

async function readDoc(absolute: string, relativePath: string, maxFileBytes: number): Promise<ScanDoc | null> {
  try {
    const handle = await open(absolute, 'r')
    try {
      const size = (await handle.stat()).size
      const buffer = Buffer.alloc(Math.min(size, maxFileBytes))
      const { bytesRead } = await handle.read(buffer)
      const text = decodeBounded(buffer.subarray(0, bytesRead))
      if (text.includes('\0')) return null
      return { path: relativePath, text, truncated: size > bytesRead }
    } finally { await handle.close() }
  } catch { return null }
}

/**
 * 代表性摘录选取：按顶层目录分组轮转，浅层与根目录文件优先，
 * 在总字节预算内尽量覆盖更多目录，而不是全堆在一个模块里。
 */
export function pickExcerpts(sourceFiles: ScanSourceFile[], limits: ScanLimits): ScanExcerptFile[] {
  const groups = new Map<string, ScanSourceFile[]>()
  for (const file of sourceFiles) {
    const top = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : ''
    const key = top || '(root)'
    const group = groups.get(key) ?? []
    group.push(file)
    groups.set(key, group)
  }
  const order = [...groups.keys()].sort((a, b) => {
    if (a === '(root)') return -1
    if (b === '(root)') return 1
    return a.localeCompare(b)
  })
  for (const key of order) {
    groups.get(key)?.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
  }

  const picked: ScanExcerptFile[] = []
  let used = 0
  let progressed = true
  for (let round = 0; picked.length < limits.maxExcerptFiles && progressed; round += 1) {
    progressed = false
    for (const key of order) {
      if (picked.length >= limits.maxExcerptFiles) break
      const group = groups.get(key)
      const file = group?.[round]
      if (!file) continue
      progressed = true
      const budget = limits.totalBudgetBytes - used
      if (budget <= 0) break
      const capped = Math.min(limits.maxFileBytes, budget, Math.max(file.bytes, 1))
      picked.push({ ...file, capBytes: capped })
      used += Math.min(capped, file.bytes > 0 ? file.bytes : capped)
    }
    if (used >= limits.totalBudgetBytes) break
  }
  return picked
}

/** 读取一批摘录文件的实际文本；读取失败单独跳过，不让整个任务失败。 */
export async function readExcerpts(scan: ScanResult, files: ScanExcerptFile[] = scan.excerpts, signal?: AbortSignal): Promise<ScanExcerpt[]> {
  const result: ScanExcerpt[] = []
  for (const file of files) {
    signal?.throwIfAborted()
    try {
      const actual = await realpath(join(scan.root, ...file.path.split('/')))
      const root = await realpath(scan.root)
      const rel = relative(root, actual)
      if (rel.startsWith('..') || !isAllowedPath(file.path)) continue
      const doc = await readDoc(actual, file.path, file.capBytes)
      if (doc) result.push(doc)
    } catch { signal?.throwIfAborted(); /* 文件可能在扫描后被移动，直接跳过。 */ }
  }
  return result
}

/** Do not split UTF-8 codepoints at byte limits. */
export function decodeBounded(buffer: Buffer): string {
  const decoder = new TextDecoder('utf-8')
  return decoder.decode(buffer, { stream: true })
}
export function isAllowedPath(path: string): boolean {
  const parts = path.split('/')
  if (parts.some(p => !p || p === '..' || p === '.')) return false
  if (parts.slice(0, -1).some(shouldSkipDir)) return false
  const base = parts.at(-1)!.toLowerCase()
  return !base.startsWith('.') && !BINARY_EXTENSIONS.has(extname(base))
    && !/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|credentials.*|.*\.pem|.*\.key)$/.test(base)
}
export function isSourcePath(path: string): boolean {
  const base = basename(path).toLowerCase()
  return isAllowedPath(path) && (EXCERPT_EXTENSIONS.has(extname(path).toLowerCase()) || DOC_FILES.includes(base) || MANIFEST_FILES.has(base) || /^(dockerfile|containerfile)(\..+)?$/.test(base))
}
