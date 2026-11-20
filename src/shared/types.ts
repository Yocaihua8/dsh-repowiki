/**
 * RPC 与工具共用的请求/响应类型。
 *
 * 类型只含 zod 可序列化的字面字段；Typert 生成器会按方法签名生成校验 schema。
 * UI 侧所需的维基清单/项目条目也定义在这里，Host 与 Client 共享同一份形状。
 */

/** 一页维基的元信息（不含正文）。 */
export interface ReadingPaths { user: string[]; developer: string[]; maintainer: string[] }

/** 页面类型；Host/Client 与持久化元数据共用。 */
export type WikiPageType =
  | 'overview'
  | 'quickstart'
  | 'guide'
  | 'developer'
  | 'architecture'
  | 'module'
  | 'api'
  | 'data'
  | 'workflow'
  | 'config'
  | 'security'
  | 'testing'
  | 'ops'
  | 'troubleshooting'
  | 'extension'

/** Host 的确定性页面质量结果，随页面元信息持久化。 */
export interface PageQualityMeta {
  chars: number
  lines: number
  citations: number
  sources: number
  fences: number
  tables: number
  mermaid: number
  hard: string[]
  soft: string[]
  checkedAt?: string
}

/** 模型对页面可读性的语义审阅；与事实核验结论分开保存。 */
export interface PageReviewMeta {
  pass: boolean
  plainLanguage?: boolean | null
  relevance: boolean | null
  structure: boolean | null
  citations: boolean
  issues: string[]
  mode: 'model' | 'host-rule'
  /** 是否已执行过一轮可读性修订；达到修订上限后仍未通过只记警告不阻断发布。 */
  revised?: boolean
  checkedAt?: string
}

export interface WikiPageMeta {
  readerQuestion?: string
  scope?: string
  relatedPageIds?: string[]

  contentVersion?: string
  kind?: 'group' | 'page'
  /** 是否为带有子页面的分类导览页（Hub Page），与 Qoder 目录结构一致。 */
  isHub?: boolean
  type?: WikiPageType
  parentId?: string | null
  sources?: SourceReference[]
  /** 发布/草稿读取时的质量结果；旧清单没有此字段。 */
  quality?: PageQualityMeta
  /** 事实核验结论；没有此字段表示旧产物或尚未核验。 */
  verification?: 'supported' | 'uncertain'
  verificationIssues?: string[]
  /** 语义可读性审阅；规则核验或旧产物可能没有此字段。 */
  review?: PageReviewMeta
  id: string
  title: string
  summary: string
  file: string
  bytes: number
  /** 本页生成时实际读取的文件路径；旧清单可能只包含规划路径。 */
  related: string[]
}

/** 一个维基的清单（manifest.json 的形状）。 */
export interface WikiManifest {
  readingPaths?: ReadingPaths
  cards?: KnowledgeCard[]
  jobId?: string
  schemaVersion?: number
  revision?: string
  source?: RepositoryVersion
  model?: ModelSelection
  sourceIndex?: { path: string; hash: string }[]
  id: string
  title: string
  description: string
  repoPath: string
  language: string
  createdAt: string
  updatedAt: string
  generator: string
  pages: WikiPageMeta[]
}

/** 项目总览页里一个项目的维基摘要。 */
export interface WikiSummary {
  cards?: number
  id: string
  title: string
  pages: number
  refs: number
  updatedAt: string
}

/** wiki: null 表示尚未生成。 */
export interface ProjectEntry {
  task?: GenerationStatus | null
  name: string
  path: string
  wiki: WikiSummary | null
}

export interface ProjectListResponse {
  projects: ProjectEntry[]
}

export interface StartGenerationRequest {
  mode?: 'generate' | 'update'
  /** 仓库根目录绝对路径。 */
  path: string
}

export interface StartGenerationResponse {
  jobId?: string
  started: boolean
  wikiId: string
  repoPath: string
}

export interface GenerationStatus {
  engine?: 'legacy' | 'agent-v1'
  agentSessionId?: string
  plannerSessionId?: string
  collaboration?: 'single' | 'collaborative'
  quality?: QualityReport
  outlineVersion?: number
  currentAction?: string
  waiting?: { reason: string; attempt: number; retryAt: string; code: string }
  /** 规划阶段最近失败摘要；目录提交成功后清除。 */
  plannerHint?: { attempts: number; lastError: string; lastOutlinePages: number | null; at: string } | null
  verifiedDone?: number
  items?: GenerationItem[]
  cardsDone?: number
  processing?: number
  checkpointAt?: string
  recoverable?: boolean
  running: boolean
  stage: 'idle' | 'queued' | 'scan' | 'analyze' | 'plan' | 'pages' | 'cards' | 'verify' | 'write' | 'export' | 'done' | 'failed' | 'cancelled' | 'paused' | 'interrupted' | 'partial'
  jobId?: string
  currentPage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  model?: ModelSelection | null
  trigger?: 'manual' | 'auto'
  warning?: string | null
  wikiId: string | null
  repoPath: string | null
  pagesDone: number
  pagesTotal: number
  error: { code: string; message: string } | null
  result: { wikiId: string; title: string; pageCount: number; refs: number } | null
}

export interface CancelGenerationResponse {
  cancelled: boolean
}

export interface WikiListResponse {
  wikis: WikiManifest[]
}

export interface ReadWikiRequest {
  wikiId: string
}

export interface ReadWikiResponse {
  wiki: WikiManifest
}

export interface ReadPageRequest {
  revision?: string
  wikiId: string
  pageId: string
}

export interface ReadPageResponse {
  page: { id: string; title: string; summary: string; content: string }
}

export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface RoleModels { planner?: ModelSelection | null; writer?: ModelSelection | null; verifier?: ModelSelection | null }
export interface QualityReport { pages: number; chars: number; lines: number; sources: number; citations: number; fences: number; tables: number; mermaid: number; verified: number; warnings: string[] }
export interface ModelOption { provider: string; model: string; label: string; efforts: string[]; name?: string; source?: string; description?: string; effortOptions?: { id: string; name: string }[] }
export interface ModelCapabilities { models: ModelOption[]; defaultModel: ModelSelection | null; warnings: string[] }
export interface StorageCandidate { kind: 'job' | 'revision'; id: string; wikiId?: string; bytes: number; at: number }
export interface StoragePlan { candidates: StorageCandidate[]; jobs: number; revisions: number; bytes: number }
export interface StoragePruneRequest { keepJobs?: number; keepRevisions?: number; olderThanDays?: number }
export interface ProjectSettings {
  /** Absent in legacy requests/settings means disabled. */
  agentReference?: boolean
  language: 'zh' | 'en'
  model: ModelSelection | null
  maxPages: number
  autoUpdate: boolean
  autoExport: boolean
  collaboration?: 'single' | 'collaborative'
  concurrency?: 1 | 2 | 3
  /** 目录粒度：standard（标准，约 18–26 页）或 deep（深度，按子系统细拆至 30–45 页）。 */
  granularity?: 'standard' | 'deep'
  roles?: RoleModels
  /** 手工排除规则（.gitignore 语法），扫描时先于文件树与快照生效。 */
  exclude?: string[]
}
export interface RepositoryVersion { kind: 'working' | 'git'; commit: string | null; branch: string | null; fingerprint: string }
export interface SourceReference { id: string; path: string; startLine: number; endLine: number; hash: string; version: string }
export interface SourceExcerpt extends SourceReference { text: string }
export interface ProjectRequest { path: string }
export interface ProjectConfiguration {
  path: string; settings: ProjectSettings; canGenerate: boolean; reason: string | null
  git: { available: boolean; branch: string | null; commit: string | null }
  updateNotice: string | null
}
export interface SaveSettingsRequest { path: string; settings: ProjectSettings }
export interface JobRequest { jobId: string }
export interface JobListResponse { jobs: GenerationStatus[] }
export interface ReadSourceRequest { wikiId: string; sourceId: string; revision?: string }
export interface ReadSourceResponse { source: SourceExcerpt }
export interface SearchWikiRequest { wikiId: string; query: string }
export interface SearchWikiResponse { pages: { id: string; title: string; snippet: string }[] }
export interface ExportResponse { directory: string; files: number }

export interface GenerationItem {
  bodyState?: 'pending' | 'writing' | 'complete' | 'failed'
  cardState?: 'pending' | 'complete' | 'skipped'
  verificationState?: 'pending' | 'supported' | 'uncertain'
  qualityState?: 'pending' | 'pass' | 'warn' | 'fail'
  reviewState?: 'pending' | 'pass' | 'revise'
  id: string; title: string; parentId: string | null
  state: 'pending' | 'writing' | 'complete' | 'failed'
  step: 'pages' | 'cards' | 'verify'
  attempts?: number
  model?: ModelSelection | null
  error: string | null
}
export interface CardEvidence { sourceId: string; path: string; startLine: number; endLine: number; quote: string }
export interface KnowledgeCard {
  id: string; pageId: string; title: string; category: string; summary: string; content: string
  evidence: CardEvidence[]; verification: 'supported' | 'uncertain'; issues: string[]; version: string
  review?: PageReviewMeta
}
export interface DraftResponse { wiki: WikiManifest | null; status: GenerationStatus }
export interface ReadDraftPageRequest extends JobRequest { pageId: string }
export interface ReadDraftSourceRequest extends JobRequest { sourceId: string }
export interface SearchDraftRequest extends JobRequest { query: string }
export interface SearchCardsRequest extends ReadWikiRequest { query: string; category?: string }
export interface CardsResponse { cards: KnowledgeCard[]; revision: string | null; enabled: boolean }
export interface ReferenceRecord { at: string; sessionId: string; revision: string; cardIds: string[]; sourceIds: string[] }
export interface ReferencesResponse { enabled: boolean; cards: KnowledgeCard[]; records: ReferenceRecord[] }
