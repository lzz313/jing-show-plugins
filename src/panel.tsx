// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  host,
  IconButton,
  Image,
  Link,
  Markdown,
  plugin,
  read,
  Row,
  Select,
  set,
  Skeleton,
  Stack,
  Text,
  Textarea,
  type PanelContext,
  type Tone,
} from 'orca'
import type {
  FeedItemView,
  FeedViewData,
  SourceSelection,
  ViewId,
} from './vendor/jing-client.mjs'
import {
  appendFeedPage,
  formatClock,
  isSourceId,
  sourceOptions,
  VIEWS,
} from './vendor/jing-client.mjs'
import type { ModelCatalog, SummaryChoice } from './protocol'

const REFRESH_MS = 5 * 60_000
const CACHE_TTL_MS = REFRESH_MS
const CACHE_MAX = 24
const AUTO_FILL_MIN_ITEMS = 12
const AUTO_FILL_MAX_PAGES = 3

const EFFORT_LABELS: Record<string, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '极致',
}

function effortText(effort: string): string {
  if (!effort) return '默认'
  return `${EFFORT_LABELS[effort] ?? effort} (${effort})`
}

/** Last page the worker returned; null until it answers. */
const feed = atom<FeedViewData | null>(null)
const loading = atom(false)
const loadingMore = atom(false)
const error = atom<string | null>(null)
const notice = atom<{ tone: Tone; text: string } | null>(null)
/**
 * The manual fallback prompt, with why it is showing: no agent was found, or
 * the agent refused the pasted text. The block itself carries the message, so
 * no separate notice is needed.
 */
const prompt = atom<{ text: string; reason: 'no-agent' | 'refused' } | null>(null)
/** One agent hand-off at a time; a double click must not paste twice. */
const agentSending = atom(false)
/** Rises for every request so an older answer cannot replace a newer one. */
const requestSeq = atom(0)

/** Keyed atoms survive reloads; the default view is latest. */
const view = atom<ViewId>('jing.view', 'latest', { persist: 'plugin' })
const source = atom<SourceSelection>('jing.source', 'all', { persist: 'plugin' })

/** The local router's models and the settings default, read once per panel run. */
const catalog = atom<ModelCatalog | null>(null)
const catalogError = atom<string | null>(null)
const pickerOpen = atom(false)
/** A picker choice; null means the settings default. */
const choice = atom<SummaryChoice | null>('jing.model', null, { persist: 'plugin' })

interface SummaryState {
  itemId: string
  status: 'loading' | 'done' | 'error'
  text: string
  label: string
  effort: string
  error: string
}

/** The inline summary under one card; null when none is open. */
const summary = atom<SummaryState | null>(null)
const summarySeq = atom(0)
/** The in-flight summary; aborted when the block closes or the item changes. */
let summaryController: AbortController | null = null

interface PanelCacheEntry {
  data: FeedViewData
  at: number
}

/** Per-(view, source) cache for instant synchronous tab switches; reset per mount. */
const panelCache = new Map<string, PanelCacheEntry>()
const panelInflight = new Map<string, Promise<FeedViewData>>()
let latestDataVersion = 0
let autoFillCount = 0
let panelSession = 0

function feedKey(v: ViewId, s: SourceSelection): string {
  return `${v}:${s}`
}

function cursorKey(v: ViewId, s: SourceSelection, cursor: string): string {
  return `${v}:${s}|cursor:${cursor}`
}

function cachePeek(key: string): PanelCacheEntry | null {
  return panelCache.get(key) ?? null
}

function cacheGet(key: string): PanelCacheEntry | null {
  const entry = panelCache.get(key)
  if (!entry) return null
  panelCache.delete(key)
  panelCache.set(key, entry)
  return entry
}

function cacheSet(
  key: string,
  data: FeedViewData,
  { force = false, at = Date.now() }: { force?: boolean; at?: number } = {},
): PanelCacheEntry {
  if (data.dataVersion > latestDataVersion) {
    latestDataVersion = data.dataVersion
  }
  const existing = panelCache.get(key)
  if (!force && existing) {
    if (existing.data.dataVersion > data.dataVersion) return existing
    if (
      existing.data.dataVersion === data.dataVersion &&
      existing.data.items.length > data.items.length
    ) {
      return existing
    }
  }
  const entry: PanelCacheEntry = { data, at }
  panelCache.delete(key)
  panelCache.set(key, entry)
  while (panelCache.size > CACHE_MAX) {
    const oldest = panelCache.keys().next().value
    if (oldest === undefined) break
    panelCache.delete(oldest)
  }
  return entry
}

function isCacheFresh(entry: PanelCacheEntry | null, now = Date.now()): boolean {
  if (!entry) return false
  if (now - entry.at >= CACHE_TTL_MS) return false
  if (entry.data.dataVersion < latestDataVersion) return false
  return true
}

function dedupeRequest(
  key: string,
  start: () => Promise<FeedViewData>,
  { bypass = false }: { bypass?: boolean } = {},
): Promise<FeedViewData> {
  if (!bypass) {
    const existing = panelInflight.get(key)
    if (existing) return existing
  }
  const promise = start()
  panelInflight.set(key, promise)
  const cleanup = () => {
    if (panelInflight.get(key) === promise) panelInflight.delete(key)
  }
  promise.then(cleanup, cleanup)
  return promise
}

function previewSourceFromAll(v: ViewId, s: SourceSelection): FeedViewData | null {
  if (v !== 'latest' || s === 'all') return null
  const allEntry = cachePeek(feedKey('latest', 'all'))
  if (!allEntry?.data.items.length) return null
  const matched = allEntry.data.items.filter((entry) => entry.source === s)
  if (!matched.length) return null
  return {
    ...allEntry.data,
    source: s,
    items: matched,
    nextCursor: null,
  }
}

function errorText(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined
  if (code === 'timeout') return '请求超时，请稍后重试'
  if (code === 'unavailable') return '数据暂时不可用，请稍后重试'
  if (error instanceof Error) return error.message
  return String(error)
}

async function load(refresh: boolean): Promise<void> {
  const session = panelSession
  const request = read(requestSeq) + 1
  set(requestSeq, request)
  set(loading, true)
  // A first-page load supersedes any page still arriving.
  set(loadingMore, false)
  set(error, null)
  autoFillCount = 0
  if (refresh) closeSummary()
  const requestedView = read(view)
  const requestedSource = read(source)
  const key = feedKey(requestedView, requestedSource)
  let loadedOk = false
  let versionAdvanced = false
  try {
    const data = await dedupeRequest(
      key,
      () =>
        plugin.request('feed.get', {
          view: requestedView,
          source: requestedSource,
          refresh,
        }),
      { bypass: refresh },
    )
    if (session !== panelSession || read(requestSeq) !== request) return
    if (data.dataVersion > latestDataVersion) {
      latestDataVersion = data.dataVersion
      versionAdvanced = true
    }
    const previous = read(feed)
    const cached = cachePeek(key)
    let applied: FeedViewData = data
    // The 5-minute refresh asks for the first page again. When nothing
    // changed, keep the older pages the reader already loaded instead of
    // snapping the list back to one page.
    if (
      !refresh &&
      cached &&
      previous &&
      previous.view === data.view &&
      previous.source === data.source &&
      previous.lastUpdated === data.lastUpdated &&
      previous.dataVersion === data.dataVersion &&
      previous.items.length > data.items.length
    ) {
      applied = {
        ...data,
        items: previous.items,
        pageCounts: previous.pageCounts,
        nextCursor: previous.nextCursor,
      }
    }
    set(feed, applied)
    cacheSet(key, applied, { force: true })
    loadedOk = true
  } catch (err) {
    if (session !== panelSession || read(requestSeq) !== request) return
    set(error, errorText(err))
  } finally {
    if (session === panelSession && read(requestSeq) === request) {
      set(loading, false)
      if (loadedOk) {
        void maybeAutoFill(session)
        prefetchViews(session, refresh || versionAdvanced)
      }
    }
  }
}

async function maybeAutoFill(session: number): Promise<void> {
  if (session !== panelSession) return
  if (read(loading) || read(loadingMore)) return
  const data = read(feed)
  if (!data?.nextCursor) return
  if (data.items.length >= AUTO_FILL_MIN_ITEMS) return
  if (autoFillCount >= AUTO_FILL_MAX_PAGES) return
  autoFillCount++
  await loadMore({ auto: true })
}

async function loadMore({ auto = false }: { auto?: boolean } = {}): Promise<void> {
  const session = panelSession
  const data = read(feed)
  if (!data?.nextCursor || read(loadingMore)) return
  const request = read(requestSeq)
  const requestedView = data.view
  const requestedSource = read(source)
  const usedCursor = data.nextCursor
  set(loadingMore, true)
  let loadedOk = false
  let addedCount = 0
  try {
    const next = await dedupeRequest(
      cursorKey(requestedView, requestedSource, usedCursor),
      () =>
        plugin.request('feed.get', {
          view: requestedView,
          source: requestedSource,
          cursor: usedCursor,
        }),
    )
    // A reload, view switch or source switch while this page was in flight
    // owns the list now; do not append a page from the old one.
    if (session !== panelSession || read(requestSeq) !== request) return
    const current = read(feed)
    if (
      !current ||
      current.view !== requestedView ||
      read(view) !== requestedView ||
      read(source) !== requestedSource
    ) {
      return
    }
    const merged = appendFeedPage(current, next)
    addedCount = merged.items.length - current.items.length
    set(feed, merged)
    cacheSet(feedKey(requestedView, requestedSource), merged, { force: true })
    loadedOk = true
  } catch (err) {
    if (session !== panelSession || read(requestSeq) !== request) return
    if (!auto) {
      set(notice, { tone: 'danger', text: `加载更多失败：${errorText(err)}` })
    }
  } finally {
    if (session === panelSession && read(requestSeq) === request) {
      set(loadingMore, false)
      const latest = read(feed)
      if (
        loadedOk &&
        addedCount > 0 &&
        latest?.nextCursor &&
        latest.nextCursor !== usedCursor
      ) {
        void maybeAutoFill(session)
      }
    }
  }
}

function prefetchViews(session: number, force: boolean): void {
  if (session !== panelSession) return
  const activeView = read(view)
  const activeSource = read(source)
  for (const entry of VIEWS) {
    if (entry.id === activeView) continue
    const key = feedKey(entry.id, activeSource)
    const cached = cachePeek(key)
    const fresh = !force && isCacheFresh(cached)
    const needsTopUp =
      Boolean(cached?.data.nextCursor) &&
      (cached?.data.items.length ?? 0) < AUTO_FILL_MIN_ITEMS
    if (fresh && !needsTopUp) continue
    void prefetchOne(session, entry.id, activeSource, force, fresh ? cached : null)
  }
}

async function prefetchOne(
  session: number,
  targetView: ViewId,
  targetSource: SourceSelection,
  force: boolean,
  existing: PanelCacheEntry | null,
): Promise<void> {
  const key = feedKey(targetView, targetSource)
  try {
    let entry = existing
    if (!entry) {
      const data = await dedupeRequest(
        key,
        () =>
          plugin.request('feed.get', {
            view: targetView,
            source: targetSource,
            refresh: force || undefined,
          }),
        { bypass: force },
      )
      if (session !== panelSession) return
      if (read(view) === targetView && read(source) === targetSource) return
      entry = cacheSet(key, data, { force })
    }

    let hops = 0
    while (
      session === panelSession &&
      read(source) === targetSource &&
      read(view) !== targetView &&
      entry.data.nextCursor &&
      entry.data.items.length < AUTO_FILL_MIN_ITEMS &&
      hops < AUTO_FILL_MAX_PAGES
    ) {
      const cursor = entry.data.nextCursor
      hops++
      const next = await dedupeRequest(
        cursorKey(targetView, targetSource, cursor),
        () =>
          plugin.request('feed.get', {
            view: targetView,
            source: targetSource,
            cursor,
          }),
      )
      if (session !== panelSession) return
      if (read(view) === targetView && read(source) === targetSource) return
      const merged = appendFeedPage(entry.data, next)
      const added = merged.items.length - entry.data.items.length
      entry = cacheSet(key, merged, { force: true, at: entry.at })
      if (added === 0 || !entry.data.nextCursor || entry.data.nextCursor === cursor) {
        break
      }
    }
  } catch {
    // Background prefetches never surface as panel errors.
  }
}

async function loadModels(): Promise<void> {
  set(catalogError, null)
  try {
    const data = await plugin.request('models.list')
    set(catalog, data)
    // An empty catalog says nothing about the saved pick: the router may just
    // be starting. Keep the pick and its level until a real catalog disagrees.
    if (!data.models.length) return
    // A saved pick that the router no longer offers falls back to the default.
    const saved = read(choice)
    if (!saved) return
    const model = data.models.find((entry) => entry.id === saved.model)
    if (!model) {
      set(choice, null)
    } else if (saved.effort && !model.levels.includes(saved.effort)) {
      // `levels` can be empty: the model takes no reasoning level, so a saved
      // one must not be sent with it.
      set(choice, { ...saved, effort: '' })
    }
  } catch (err) {
    set(catalogError, errorText(err))
  }
}

export function setup(ctx: PanelContext): void {
  panelSession++
  panelCache.clear()
  panelInflight.clear()
  latestDataVersion = 0
  autoFillCount = 0
  const session = panelSession
  const timer = setInterval(() => {
    if (read(ctx.visible)) void load(false)
  }, REFRESH_MS)
  ctx.subscriptions.push({
    dispose: () => {
      clearInterval(timer)
      if (panelSession === session) {
        panelSession++
        panelCache.clear()
        panelInflight.clear()
      }
    },
  })
  void load(false)
  void loadModels()
}

function clearTransientMessages(): void {
  set(notice, null)
  set(prompt, null)
}

function applySelectionChange(): void {
  const session = panelSession
  const nextView = read(view)
  const nextSource = read(source)
  autoFillCount = 0
  set(requestSeq, read(requestSeq) + 1)
  set(loadingMore, false)
  set(error, null)
  closeSummary()
  clearTransientMessages()

  const cached = cacheGet(feedKey(nextView, nextSource))
  if (cached) {
    set(feed, cached.data)
    if (isCacheFresh(cached)) {
      set(loading, false)
      void maybeAutoFill(session)
      prefetchViews(session, false)
      return
    }
    void load(false)
    return
  }

  const preview = previewSourceFromAll(nextView, nextSource)
  if (preview) {
    set(feed, preview)
  } else {
    set(feed, null)
  }
  void load(false)
}

function selectView(next: string): void {
  const value: ViewId = next === 'hot' || next === 'rising' ? next : 'latest'
  if (read(view) === value) return
  set(view, value)
  applySelectionChange()
}

function selectSource(next: string): void {
  const value: SourceSelection =
    next === 'all' ? 'all' : isSourceId(next) ? next : 'all'
  if (read(source) === value) return
  set(source, value)
  applySelectionChange()
}

/** Opening the picker before the catalog arrived retries the read. */
function togglePicker(): void {
  const open = !read(pickerOpen)
  set(pickerOpen, open)
  if (open && !read(catalog)) void loadModels()
}

/** The picker choice, or the settings defaults while no pick is made. */
function resolvedChoice(): SummaryChoice | null {
  const saved = read(choice)
  const data = read(catalog)
  if (saved) {
    const model = data?.models.find((entry) => entry.id === saved.model)
    if (!data || model) {
      const levels = model?.levels ?? []
      // Before the catalog loads the level is unknown, so the saved one is
      // kept; once it is known, the model must actually accept it (an empty
      // `levels` accepts none).
      const effort = !data || (saved.effort && levels.includes(saved.effort))
        ? saved.effort
        : ''
      return { model: saved.model, effort, label: model?.label ?? saved.label }
    }
  }
  if (data) {
    return {
      model: data.defaultModel,
      effort: data.defaultEffort,
      label: data.defaultLabel,
    }
  }
  return null
}

function choiceLabel(): string {
  const current = resolvedChoice()
  if (!current) return '默认 · 本地路由'
  return `${current.label} · ${effortText(current.effort)}`
}

function chooseModel(next: string): void {
  const data = read(catalog)
  const model = data?.models.find((entry) => entry.id === next)
  const previous = resolvedChoice()
  const levels = model?.levels ?? []
  const effort =
    previous &&
    previous.model === next &&
    previous.effort &&
    levels.includes(previous.effort)
      ? previous.effort
      : ''
  set(choice, {
    model: next,
    effort,
    label: model?.label ?? next,
  })
}

function chooseEffort(next: string): void {
  const current = resolvedChoice()
  if (!current) return
  set(choice, { ...current, effort: next === 'default' ? '' : next })
}

function modelOptions(): { value: string; label: string }[] {
  const data = read(catalog)
  if (data?.models.length) {
    return data.models.map((model) => ({
      value: model.id,
      label: model.label,
    }))
  }
  const current = resolvedChoice()
  return current ? [{ value: current.model, label: current.label }] : []
}

function levelOptions(): { value: string; label: string }[] {
  const current = resolvedChoice()
  const data = read(catalog)
  const model = data?.models.find((entry) => entry.id === current?.model)
  const levels = model?.levels ?? []
  // Select options need a non-empty value; `default` means "send no level".
  return [
    { value: 'default', label: '默认（不指定）' },
    ...levels.map((level) => ({ value: level, label: effortText(level) })),
  ]
}

async function openItem(item: FeedItemView): Promise<void> {
  if (!item.url) {
    set(notice, { tone: 'neutral', text: '这条没有可打开的链接' })
    return
  }
  try {
    const result = await host.call('shell.openExternal', { url: item.url })
    if (!result.opened) {
      set(notice, { tone: 'neutral', text: '已取消打开链接' })
    }
  } catch (err) {
    set(notice, { tone: 'danger', text: errorText(err) })
  }
}

function closeSummary(): void {
  // Closing the block cancels the model call: its answer has nowhere to go,
  // and the worker should stop paying for it.
  summaryController?.abort()
  summaryController = null
  set(summarySeq, read(summarySeq) + 1)
  set(summary, null)
}

async function summarize(item: FeedItemView): Promise<void> {
  const request = read(summarySeq) + 1
  set(summarySeq, request)
  set(prompt, null)
  set(notice, null)
  // A second summarize on another card replaces the first request.
  summaryController?.abort()
  const controller = new AbortController()
  summaryController = controller
  const selected = resolvedChoice()
  set(summary, {
    itemId: item.id,
    status: 'loading',
    text: '',
    label: selected?.label ?? '本地模型',
    effort: selected?.effort ?? '',
    error: '',
  })
  try {
    const result = await plugin.request(
      'summary.generate',
      { item, choice: selected },
      { timeoutMs: 100_000, signal: controller.signal },
    )
    if (read(summarySeq) !== request) return
    set(summary, {
      itemId: item.id,
      status: 'done',
      text: result.text,
      label: result.label,
      effort: result.effort,
      error: '',
    })
  } catch (err) {
    if (read(summarySeq) !== request) return
    set(summary, {
      itemId: item.id,
      status: 'error',
      text: '',
      label: selected?.label ?? '本地模型',
      effort: selected?.effort ?? '',
      error: errorText(err),
    })
  } finally {
    if (summaryController === controller) summaryController = null
  }
}

/** Fallback when the local router is not reachable: hand the prompt to an agent. */
async function sendToAgent(item: FeedItemView): Promise<void> {
  if (read(agentSending)) return
  set(agentSending, true)
  set(notice, null)
  set(prompt, null)
  try {
    const result = await plugin.request('item.summarize', { item })
    if (result.sent) {
      set(notice, {
        tone: 'success',
        text: `已发送给 ${result.agent ?? '本地 agent'}`,
      })
      return
    }
    // The prompt block carries the message, so no second notice is set. A
    // refusal is distinct from having no agent at all.
    set(prompt, {
      text: result.prompt,
      reason: result.reason === 'refused' ? 'refused' : 'no-agent',
    })
  } catch (err) {
    set(notice, { tone: 'danger', text: `发送失败：${errorText(err)}` })
  } finally {
    set(agentSending, false)
  }
}

function SummaryBlock({
  item,
  state,
}: {
  item: FeedItemView
  state: SummaryState
}) {
  const sending = read(agentSending)
  const meta = `${state.label || '本地模型'}${
    state.effort ? ` · ${effortText(state.effort)}` : ''
  }`
  return (
    <Box
      direction="column"
      gap="xs"
      padding="sm"
      border
      radius="sm"
      background="muted"
    >
      <Row justify="between" align="center">
        <Text muted size="xs">
          {`总结 · ${meta}`}
        </Text>
        {state.status === 'loading' ? (
          <Text muted size="xs">
            正在总结…
          </Text>
        ) : state.status === 'error' ? (
          <Text tone="danger" size="xs">
            失败
          </Text>
        ) : null}
      </Row>
      {state.status === 'done' ? <Markdown content={state.text} /> : null}
      {state.status === 'error' ? (
        <Stack gap="xs">
          <Callout tone="danger" title="总结失败">
            {state.error}
          </Callout>
          <Row gap="xs" align="center">
            <Button
              variant="ghost"
              size="xs"
              icon="bot"
              disabled={sending}
              onPress={() => void sendToAgent(item)}
            >
              {sending ? '发送中…' : '发给本地 Agent'}
            </Button>
          </Row>
        </Stack>
      ) : null}
    </Box>
  )
}

function ItemCard({ item }: { item: FeedItemView }) {
  const current = read(summary)
  const isCurrent = current?.itemId === item.id
  return (
    <Box
      direction="column"
      gap="xs"
      padding="sm"
      border
      radius="sm"
      background="card"
    >
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Badge tone="neutral">{item.sourceShort}</Badge>
          <Text muted size="xs">
            {item.timeLabel}
          </Text>
          {item.isHot ? <Badge tone="accent">热</Badge> : null}
        </Row>
        {item.metricLabel ? (
          <Text muted size="xs">
            {item.metricLabel}
          </Text>
        ) : null}
      </Row>
      {item.titleOriginal ? (
        <Text muted truncate>
          {item.titleOriginal}
        </Text>
      ) : null}
      <Text weight="semibold" truncate>
        {item.title}
      </Text>
      {item.summaryOriginal ? (
        <Text muted size="sm" truncate>
          {item.summaryOriginal}
        </Text>
      ) : null}
      {item.summary ? (
        <Text muted size="sm" truncate>
          {item.summary}
        </Text>
      ) : null}
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Button
            variant="ghost"
            size="xs"
            icon="open-external"
            onPress={() => void openItem(item)}
          >
            打开
          </Button>
          <Button
            variant="ghost"
            size="xs"
            icon="bot"
            onPress={() => void summarize(item)}
          >
            {isCurrent ? '再总结' : '总结'}
          </Button>
          {isCurrent ? (
            <Button variant="ghost" size="xs" onPress={closeSummary}>
              收起
            </Button>
          ) : null}
        </Row>
        <Text muted size="xs">
          {item.sourceName}
        </Text>
      </Row>
      {isCurrent && current ? <SummaryBlock item={item} state={current} /> : null}
    </Box>
  )
}

export default function Panel() {
  const data = read(feed)
  const busy = read(loading)
  const more = read(loadingMore)
  const currentError = read(error)
  const currentView = read(view)
  const currentSource = read(source)
  const currentNotice = read(notice)
  const currentPrompt = read(prompt)
  const currentCatalog = read(catalog)
  const currentCatalogError = read(catalogError)
  const currentChoice = resolvedChoice()
  const items = data?.items ?? []

  return (
    <Box direction="column" gap="sm" height="100%">
      <Row gap="xs" align="center">
        <Box direction="row" gap="xs" align="center" shrink={false}>
          {VIEWS.map((entry) =>
            currentView === entry.id ? (
              <Badge key={entry.id} tone="accent">
                {entry.label}
              </Badge>
            ) : (
              <Link key={entry.id} onPress={() => selectView(entry.id)}>
                {entry.label}
              </Link>
            ),
          )}
        </Box>
        <Box grow />
        <Box direction="row" gap="xs" align="center" shrink={false}>
          <Box width={18} height={18} shrink={false}>
            <Image src="assets/logo.png" alt="" size="full" fit="contain" />
          </Box>
          <Text weight="semibold" size="xs" truncate>
            jing.show
          </Text>
        </Box>
        <Box width={104} shrink={false}>
          <Select
            label="来源"
            labelHidden
            value={currentSource}
            options={sourceOptions()}
            onChange={selectSource}
          />
        </Box>
        <Box shrink={false}>
          <Text muted size="xs">
            {data && data.lastUpdated
              ? formatClock(data.lastUpdated)
              : busy
                ? '载入中…'
                : ''}
          </Text>
        </Box>
        <Box shrink={false}>
          <IconButton
            icon="refresh"
            label="刷新"
            tooltip={
              data && data.lastUpdated
                ? `更新于 ${formatClock(data.lastUpdated)} · 5 分钟自动刷新`
                : '刷新（5 分钟自动刷新）'
            }
            size="xs"
            disabled={busy}
            onPress={() => void load(true)}
          />
        </Box>
      </Row>

      {currentError ? (
        <Callout tone="warning" title="暂时取不到数据">
          {currentError}
        </Callout>
      ) : null}

      {currentNotice ? (
        <Row gap="xs" align="center">
          <Box grow>
            <Callout tone={currentNotice.tone} title={currentNotice.text} />
          </Box>
          <Button
            variant="ghost"
            size="xs"
            onPress={() => set(notice, null)}
          >
            关闭
          </Button>
        </Row>
      ) : null}

      {currentPrompt ? (
        <Stack gap="xs">
          <Callout
            tone={currentPrompt.reason === 'refused' ? 'danger' : 'warning'}
            title={
              currentPrompt.reason === 'refused'
                ? '本地 agent 拒绝了提示词'
                : '没有找到可发送的 agent'
            }
          >
            {currentPrompt.reason === 'refused'
              ? '可以复制下面的提示词手动发送。'
              : '提示词已准备好，复制到任意 agent 即可。'}
          </Callout>
          <Textarea label="总结提示词" value={currentPrompt.text} rows={6} />
          <Row justify="between" align="center">
            <Text muted size="xs">
              复制后粘贴到任意 agent。
            </Text>
            <Button
              variant="ghost"
              size="xs"
              onPress={() => set(prompt, null)}
            >
              关闭
            </Button>
          </Row>
        </Stack>
      ) : null}

      {busy && !data ? <Skeleton lines={5} label="正在加载资讯" /> : null}

      {!busy && !currentError && items.length === 0 ? (
        <EmptyState
          title="没有内容"
          description="换一个来源或视图试试，或点刷新。"
          icon="book"
        />
      ) : null}

      {items.length > 0 ? (
        <Box
          grow
          minHeight={0}
          scroll="y"
          direction="column"
          gap="xs"
          padding="xs"
          border
          radius="md"
          background="muted"
        >
          {items.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </Box>
      ) : null}

      {read(pickerOpen) ? (
        <Box
          direction="column"
          gap="xs"
          padding="sm"
          border
          radius="sm"
          background="muted"
        >
          <Row justify="between" align="center">
            <Text weight="semibold" size="sm">
              模型设置
            </Text>
            <Button
              variant="ghost"
              size="xs"
              onPress={() => set(pickerOpen, false)}
            >
              收起
            </Button>
          </Row>
          <Select
            label="模型"
            value={currentChoice?.model ?? ''}
            options={modelOptions()}
            disabled={!currentCatalog}
            onChange={chooseModel}
          />
          <Select
            label="级别"
            value={currentChoice?.effort || 'default'}
            options={levelOptions()}
            disabled={!currentCatalog}
            onChange={chooseEffort}
          />
          <Row gap="xs" align="center">
            <Button
              variant="ghost"
              size="xs"
              disabled={!read(choice)}
              onPress={() => set(choice, null)}
            >
              恢复默认
            </Button>
            <Text muted size="xs">
              {`当前：${choiceLabel()}`}
            </Text>
          </Row>
          {currentCatalogError ? (
            <Row gap="xs" align="center">
              <Text tone="warning" size="xs">
                {currentCatalogError}
              </Text>
              <Button
                variant="ghost"
                size="xs"
                icon="refresh"
                onPress={() => void loadModels()}
              >
                重试
              </Button>
            </Row>
          ) : currentCatalog ? (
            <Text muted size="xs">
              {`默认：${currentCatalog.defaultLabel} · ${effortText(
                currentCatalog.defaultEffort,
              )}。总结直接展开在条目下方。`}
            </Text>
          ) : null}
        </Box>
      ) : null}

      <Row justify="between" align="center">
        <Text muted size="xs">
          {data ? `${items.length} 条${more ? ' · 加载中…' : ''}` : ''}
        </Text>
        <Row gap="xs" align="center">
          <Button
            variant="ghost"
            size="xs"
            icon="settings"
            tooltip={`模型设置 · ${choiceLabel()}`}
            onPress={togglePicker}
          >
            模型设置
          </Button>
          {data?.nextCursor ? (
            <Button
              variant="ghost"
              size="xs"
              icon="download"
              disabled={more}
              onPress={() => void loadMore()}
            >
              加载更多
            </Button>
          ) : null}
        </Row>
      </Row>
    </Box>
  )
}
