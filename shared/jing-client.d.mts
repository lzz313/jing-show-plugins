/**
 * Types for plugins/shared/jing-client.mjs. Kept next to the implementation
 * so the Orca worker can import the plain ESM file with full type checking.
 */

export type SourceId =
  | 'x'
  | 'v2ex'
  | 'nodeseek'
  | 'linuxdo'
  | 'hn'
  | 'github'
  | 'reddit'
  | 'hf-papers'
  | 'simonw'
  | 'google-ai'
  | 'producthunt'

export type ViewId = 'latest' | 'hot' | 'rising'
export type SourceSelection = SourceId | 'all'

export interface SourceMeta {
  id: SourceId
  name: string
  shortName: string
  home: string
  color: string
}

export interface FeedItemView {
  id: string
  source: SourceId
  sourceName: string
  sourceShort: string
  sourceColor: string
  /** Chinese translation when one exists, else the original title. */
  title: string
  /** The English (or other original) title, kept when `title` is translated. */
  titleOriginal: string
  /** Chinese translation when prose needed one, else the original summary. */
  summary: string
  /** The original summary, kept when `summary` is a translation. */
  summaryOriginal: string
  url: string
  publishedAt: number
  timeLabel: string
  metricLabel: string
  isHot: boolean
  hotScore: number
}

export interface FeedCounts {
  all: number
  bySource: Partial<Record<SourceId, number>>
}

export interface FeedViewData {
  view: ViewId
  source: SourceSelection
  items: FeedItemView[]
  counts: FeedCounts
  /** Counts within this fetched page, not the whole catalog. */
  pageCounts: FeedCounts
  totals: { hot: number; rising: number }
  lastUpdated: number
  dataVersion: number
  /** Cursor for the next (older) page; null when this view has no more. */
  nextCursor: string | null
  fetchedAt: number
  fallback: boolean
}

export interface FetchLikeResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    signal?: AbortSignal
  },
) => Promise<FetchLikeResponse>

export interface FetchFeedOptions {
  view?: ViewId
  source?: SourceSelection | string
  limit?: number
  cursor?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: number
}

export const CLIENT_VERSION: string
export const ORIGIN: string
export const USER_AGENT: string
export const VIEWS: readonly { id: ViewId; label: string }[]
export const SOURCE_ORDER: readonly SourceId[]
export const SOURCES: Record<SourceId, SourceMeta>

export function isSourceId(value: unknown): value is SourceId
export function sourceMeta(value: unknown): SourceMeta | null
export function sourceOptions(): { value: SourceSelection; label: string }[]
export function viewLabel(value: string): string
export function feedLimit(view: ViewId): number
export function fetchFeed(options?: FetchFeedOptions): Promise<FeedViewData>
export function toFeedView(
  raw: unknown,
  options?: { view?: string; source?: string; now?: number },
): FeedViewData
export function toItemView(item: unknown, now?: number): FeedItemView

export function decodeEntities(text: unknown): string
export function stripHtml(text: unknown): string
export function stripUrls(text: unknown): string
export function truncate(text: unknown, max?: number): string
export function safeUrl(value: unknown): string

export function formatCompactNumber(value: number): string
export function pad2(value: number): string
export function formatClock(timestamp: number): string
export function formatDateTime(timestamp: number): string
export function formatRelativeTime(timestamp: number, now?: number): string
export function formatMetric(item: unknown): string

export function buildPrompt(item: FeedItemView): string
