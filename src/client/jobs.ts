import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type * as T from '../shared/types.js'

export interface RepoWikiRemote {
  pauseJob(request: T.JobRequest, signal?: AbortSignal): Promise<RemoteResult<T.GenerationStatus>>
  resumeJob(request: T.JobRequest, signal?: AbortSignal): Promise<RemoteResult<T.GenerationStatus>>
  retryJob(request: T.JobRequest, signal?: AbortSignal): Promise<RemoteResult<T.GenerationStatus>>
  readDraft(request: T.JobRequest, signal?: AbortSignal): Promise<RemoteResult<T.DraftResponse>>
  readDraftPage(request: T.ReadDraftPageRequest, signal?: AbortSignal): Promise<RemoteResult<T.ReadPageResponse>>
  readDraftSource(request: T.ReadDraftSourceRequest, signal?: AbortSignal): Promise<RemoteResult<T.ReadSourceResponse>>
  searchDraft(request: T.SearchDraftRequest, signal?: AbortSignal): Promise<RemoteResult<T.SearchWikiResponse>>
  searchCards(request: T.SearchCardsRequest, signal?: AbortSignal): Promise<RemoteResult<T.CardsResponse>>
  getReferences(request: T.ProjectRequest, signal?: AbortSignal): Promise<RemoteResult<T.ReferencesResponse>>
  listProjects(signal?: AbortSignal): Promise<RemoteResult<T.ProjectListResponse>>
  getProjectConfig(request: T.ProjectRequest, signal?: AbortSignal): Promise<RemoteResult<T.ProjectConfiguration>>
  saveProjectConfig(request: T.SaveSettingsRequest, signal?: AbortSignal): Promise<RemoteResult<T.ProjectConfiguration>>
  getModelCapabilities(signal?: AbortSignal): Promise<RemoteResult<T.ModelCapabilities>>
  startGeneration(request: T.StartGenerationRequest, signal?: AbortSignal): Promise<RemoteResult<T.StartGenerationResponse>>
  listJobs(signal?: AbortSignal): Promise<RemoteResult<T.JobListResponse>>
  getStoragePlan(signal?: AbortSignal): Promise<RemoteResult<T.StoragePlan>>
  pruneStorage(request: T.StoragePruneRequest, signal?: AbortSignal): Promise<RemoteResult<T.StoragePlan>>
  cancelJob(request: T.JobRequest, signal?: AbortSignal): Promise<RemoteResult<T.CancelGenerationResponse>>
  readWiki(request: T.ReadWikiRequest, signal?: AbortSignal): Promise<RemoteResult<T.ReadWikiResponse>>
  readPage(request: T.ReadPageRequest, signal?: AbortSignal): Promise<RemoteResult<T.ReadPageResponse>>
  readSource(request: T.ReadSourceRequest, signal?: AbortSignal): Promise<RemoteResult<T.ReadSourceResponse>>
  searchWiki(request: T.SearchWikiRequest, signal?: AbortSignal): Promise<RemoteResult<T.SearchWikiResponse>>
  exportWiki(request: T.ReadWikiRequest, signal?: AbortSignal): Promise<RemoteResult<T.ExportResponse>>
}
export type PanelContext = Omit<Context, 'remote'> & { remote: { repowiki: RepoWikiRemote } }
export async function call<T>(promise: Promise<RemoteResult<T>>): Promise<T> {
  const response = await promise
  if (!response.ok) throw new Error(response.error.message)
  return response.value
}
let snapshot: { jobs: T.GenerationStatus[]; error: string } = { jobs: [], error: '' }
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const useJobs = () => useSyncExternalStore(subscribe, () => snapshot)
let refresh: () => Promise<void> = async () => {}
export const refreshJobs = () => refresh()

/** This observer belongs to the plugin, not a mounted panel. The Host owns execution. */
export function watchJobs(remote: RepoWikiRemote): () => void {
  let stopped = false, pending: Promise<void> | null = null
  const controller = new AbortController()
  const tick = (): Promise<void> => {
    if (pending) return pending
    pending = (async () => {
      let next: typeof snapshot
      try { next = { jobs: (await call(remote.listJobs(controller.signal))).jobs, error: '' } }
      catch (error) { next = { ...snapshot, error: error instanceof Error ? error.message : String(error) } }
      if (!stopped && JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; for (const fn of listeners) fn() }
    })().finally(() => { pending = null })
    return pending
  }
  refresh = tick
  void tick()
  let timer: number | undefined
  const schedule = () => {
    timer = window.setTimeout(() => {
      if (document.visibilityState !== 'hidden') void tick()
      schedule()
    }, snapshot.jobs.some(job => job.running) ? 1500 : 5000)
  }
  schedule()
  const wake = () => { if (document.visibilityState === 'visible') void tick() }
  document.addEventListener('visibilitychange', wake)
  return () => { stopped = true; controller.abort(); if (timer) window.clearTimeout(timer); document.removeEventListener('visibilitychange', wake); if (refresh === tick) refresh = async () => {} }
}
