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
import { formatClock, isSourceId, sourceOptions, VIEWS } from './vendor/jing-client.mjs'
import type { ModelCatalog, SummaryChoice } from './protocol'

const REFRESH_MS = 5 * 60_000

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
const prompt = atom<string | null>(null)
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
  const request = read(requestSeq) + 1
  set(requestSeq, request)
  set(loading, true)
  set(error, null)
  if (refresh) closeSummary()
  try {
    const data = await plugin.request('feed.get', {
      view: read(view),
      source: read(source),
      refresh,
    })
    if (read(requestSeq) !== request) return
    set(feed, data)
  } catch (err) {
    if (read(requestSeq) !== request) return
    set(error, errorText(err))
  } finally {
    if (read(requestSeq) === request) set(loading, false)
  }
}

async function loadMore(): Promise<void> {
  const data = read(feed)
  if (!data?.nextCursor || read(loadingMore)) return
  const requestedView = data.view
  const requestedSource = read(source)
  set(loadingMore, true)
  try {
    const next = await plugin.request('feed.get', {
      view: requestedView,
      source: requestedSource,
      cursor: data.nextCursor,
    })
    const current = read(feed)
    if (
      !current ||
      current.view !== requestedView ||
      read(view) !== requestedView ||
      read(source) !== requestedSource
    ) {
      return
    }
    const seen = new Set(current.items.map((item) => item.id))
    set(feed, {
      ...current,
      items: [
        ...current.items,
        ...next.items.filter((item) => !seen.has(item.id)),
      ],
      counts: next.counts,
      nextCursor: next.nextCursor,
      fetchedAt: next.fetchedAt,
    })
  } catch (err) {
    set(notice, { tone: 'danger', text: `加载更多失败：${errorText(err)}` })
  } finally {
    set(loadingMore, false)
  }
}

async function loadModels(): Promise<void> {
  set(catalogError, null)
  try {
    const data = await plugin.request('models.list')
    set(catalog, data)
    // A saved pick that the router no longer offers falls back to the default.
    const saved = read(choice)
    if (!saved) return
    const model = data.models.find((entry) => entry.id === saved.model)
    if (!model) {
      set(choice, null)
    } else if (saved.effort && model.levels.length && !model.levels.includes(saved.effort)) {
      set(choice, { ...saved, effort: '' })
    }
  } catch (err) {
    set(catalogError, errorText(err))
  }
}

export function setup(ctx: PanelContext): void {
  const timer = setInterval(() => {
    if (read(ctx.visible)) void load(false)
  }, REFRESH_MS)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void load(false)
  void loadModels()
}

function selectView(next: string): void {
  const value: ViewId = next === 'hot' || next === 'rising' ? next : 'latest'
  if (read(view) === value) return
  set(view, value)
  closeSummary()
  void load(false)
}

function selectSource(next: string): void {
  const value: SourceSelection =
    next === 'all' ? 'all' : isSourceId(next) ? next : 'all'
  if (read(source) === value) return
  set(source, value)
  closeSummary()
  void load(false)
}

/** The picker choice, or the settings defaults while no pick is made. */
function resolvedChoice(): SummaryChoice | null {
  const saved = read(choice)
  const data = read(catalog)
  if (saved) {
    const model = data?.models.find((entry) => entry.id === saved.model)
    if (!data || model) {
      const levels = model?.levels ?? []
      const effort =
        saved.effort && (levels.length === 0 || levels.includes(saved.effort))
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
    (levels.length === 0 || levels.includes(previous.effort))
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
  set(summarySeq, read(summarySeq) + 1)
  set(summary, null)
}

async function summarize(item: FeedItemView): Promise<void> {
  const request = read(summarySeq) + 1
  set(summarySeq, request)
  set(prompt, null)
  set(notice, null)
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
      { timeoutMs: 100_000 },
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
  }
}

/** Fallback when the local router is not reachable: hand the prompt to an agent. */
async function sendToAgent(item: FeedItemView): Promise<void> {
  set(notice, null)
  set(prompt, null)
  try {
    const result = await plugin.request('item.summarize', { item })
    if (result.sent) {
      set(notice, {
        tone: 'success',
        text: `已发送给 ${result.agent ?? '本地 agent'}`,
      })
    } else {
      set(prompt, result.prompt)
      set(notice, { tone: 'warning', text: '没有找到可发送的 agent' })
    }
  } catch (err) {
    set(notice, { tone: 'danger', text: `发送失败：${errorText(err)}` })
  }
}

function SummaryBlock({
  item,
  state,
}: {
  item: FeedItemView
  state: SummaryState
}) {
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
              onPress={() => void sendToAgent(item)}
            >
              发给本地 Agent
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
  const promptText = read(prompt)
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
        <Callout tone={currentNotice.tone} title={currentNotice.text} />
      ) : null}

      {promptText ? (
        <Stack gap="xs">
          <Callout tone="warning" title="没有找到可发送的 agent">
            提示词已准备好，复制到任意 agent 即可。
          </Callout>
          <Textarea label="总结提示词" value={promptText} rows={6} />
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
            <Text tone="warning" size="xs">
              {currentCatalogError}
            </Text>
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
            onPress={() => set(pickerOpen, !read(pickerOpen))}
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
