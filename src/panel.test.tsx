// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import type { FeedItemView, FeedViewData } from './vendor/jing-client.mjs'
import type { ModelCatalog, SummaryChoice } from './protocol'
import * as panel from './panel'

const item = (overrides: Partial<FeedItemView> = {}): FeedItemView => ({
  id: 'v2ex-1',
  source: 'v2ex',
  sourceName: 'V2EX',
  sourceShort: 'V2EX',
  sourceColor: '#4b5563',
  title: '中文标题',
  titleOriginal: 'English title',
  summary: '中文摘要',
  summaryOriginal: '',
  url: 'https://www.v2ex.com/t/1',
  publishedAt: Date.now() - 12 * 60_000,
  timeLabel: '12 分钟前',
  metricLabel: '32 回复',
  isHot: true,
  hotScore: 80,
  ...overrides,
})

const feed: FeedViewData = {
  view: 'latest',
  source: 'all',
  items: [item()],
  counts: { all: 1, bySource: { v2ex: 1 } },
  pageCounts: { all: 1, bySource: { v2ex: 1 } },
  totals: { hot: 1, rising: 0 },
  lastUpdated: Date.now() - 30_000,
  dataVersion: 42,
  nextCursor: null,
  fetchedAt: Date.now(),
  fallback: false,
}

const catalog: ModelCatalog = {
  models: [
    {
      id: 'auto/deepseek-v4.1-flash',
      label: 'DeepSeek V4.1 Flash',
      levels: ['low', 'medium', 'high'],
    },
    {
      id: 'codex/gpt-6-luna',
      label: 'GPT-6-Luna',
      levels: ['medium', 'max'],
    },
  ],
  defaultModel: 'auto/deepseek-v4.1-flash',
  defaultLabel: 'DeepSeek V4.1 Flash',
  defaultEffort: 'high',
}

function summaryFor(choice: SummaryChoice | null | undefined) {
  return {
    text: '要点一\n要点二',
    model: choice?.model ?? catalog.defaultModel,
    label: choice?.label ?? catalog.defaultLabel,
    effort: choice?.effort ?? catalog.defaultEffort,
  }
}

test('renders the feed, keeps original titles and opens a link', async () => {
  const host = mockHost({
    requests: {
      'feed.get': (input) =>
        input?.view === 'hot'
          ? {
              ...feed,
              view: 'hot',
              items: [item({ id: 'hn-1', title: '热点标题', titleOriginal: '' })],
            }
          : feed,
      'models.list': catalog,
      'summary.generate': (input) => summaryFor(input?.choice),
      'item.summarize': { sent: true, prompt: '', agent: 'Claude Code' },
    },
  })
  const view = await mount(panel, { host })

  assert.ok(view.find({ text: 'English title' }))
  assert.ok(view.find({ text: '中文标题' }))
  assert.ok(view.find({ text: '中文摘要' }))

  const hot = view.findAll({ text: '热点' })[0]
  assert.ok(hot)
  await view.press(hot)
  assert.ok(view.find({ text: '热点标题' }))

  const open = view.findAll({ text: '打开' })[0]
  assert.ok(open)
  await view.press(open)
  const opened = host.callsOf('shell.openExternal')
  assert.equal(opened.length, 1)
  assert.deepEqual(opened[0], { url: 'https://www.v2ex.com/t/1' })

  const summarize = view.findAll({ text: '总结' })[0]
  assert.ok(summarize)
  await view.press(summarize)
  assert.ok(view.find({ text: /要点一/ }))
  assert.ok(view.find({ text: /总结 · DeepSeek V4\.1 Flash · 高 \(high\)/ }))

  const close = view.findAll({ text: '收起' })[0]
  assert.ok(close)
  await view.press(close)
  assert.equal(view.find({ text: /要点一/ }), null)

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('picks a model and level and sends them with the next summary', async () => {
  const host = mockHost({
    requests: {
      'feed.get': feed,
      'models.list': catalog,
      'summary.generate': (input) => summaryFor(input?.choice),
      'item.summarize': { sent: true, prompt: '', agent: 'Claude Code' },
    },
  })
  const view = await mount(panel, { host })

  const settings = view.findAll({ text: '模型设置' })[0]
  assert.ok(settings)
  await view.press(settings)
  assert.ok(view.find({ text: '收起' }))
  await view.select({ label: '模型' }, 'codex/gpt-6-luna')
  await view.select({ label: '级别' }, 'max')

  const summarize = view.findAll({ text: '总结' })[0]
  assert.ok(summarize)
  await view.press(summarize)

  const calls = host.callsOf('plugin.request') as {
    name: string
    input?: { choice?: SummaryChoice | null }
  }[]
  const call = calls.find((entry) => entry.name === 'summary.generate')
  assert.deepEqual(call?.input?.choice, {
    model: 'codex/gpt-6-luna',
    effort: 'max',
    label: 'GPT-6-Luna',
  })
  assert.deepEqual(view.persisted.plugin['jing.model'], {
    model: 'codex/gpt-6-luna',
    effort: 'max',
    label: 'GPT-6-Luna',
  })
  assert.ok(view.find({ text: /总结 · GPT-6-Luna · 最高 \(max\)/ }))

  const reset = view.findAll({ text: '恢复默认' })[0]
  assert.ok(reset)
  await view.press(reset)
  assert.ok(!view.persisted.plugin['jing.model'])
  await view.unmount()
})

test('shows a summary error and can hand the prompt to an agent', async () => {
  const host = mockHost({
    requests: {
      'feed.get': feed,
      'models.list': catalog,
      'summary.generate': () => {
        throw new Error('连不上本地模型服务')
      },
      'item.summarize': { sent: true, prompt: '', agent: 'Claude Code' },
    },
  })
  const view = await mount(panel, { host })

  const summarize = view.findAll({ text: '总结' })[0]
  assert.ok(summarize)
  await view.press(summarize)
  assert.ok(view.find({ text: '失败' }))
  assert.ok(view.find({ text: /连不上本地模型服务/ }))

  const fallback = view.findAll({ text: '发给本地 Agent' })[0]
  assert.ok(fallback)
  await view.press(fallback)
  assert.ok(view.find({ text: /已发送给 Claude Code/ }))
  await view.unmount()
})

test('asks the worker for the selected source', async () => {
  const host = mockHost({
    requests: {
      'feed.get': feed,
      'models.list': catalog,
      'summary.generate': (input) => summaryFor(input?.choice),
      'item.summarize': { sent: false, prompt: 'prompt', reason: 'no-agent' },
    },
  })
  const view = await mount(panel, { host })

  await view.select({ label: '来源' }, 'v2ex')
  const calls = host.callsOf('plugin.request') as {
    name: string
    input?: { source?: string }
  }[]
  const last = calls[calls.length - 1]
  assert.equal(last?.name, 'feed.get')
  assert.equal(last?.input?.source, 'v2ex')
  await view.unmount()
})

test('shows the prompt when the agent fallback finds no agent', async () => {
  const host = mockHost({
    requests: {
      'feed.get': feed,
      'models.list': catalog,
      'summary.generate': () => {
        throw new Error('连不上本地模型服务')
      },
      'item.summarize': {
        sent: false,
        prompt: '请用中文总结这条资讯。',
        reason: 'no-agent',
      },
    },
  })
  const view = await mount(panel, { host })

  const summarize = view.findAll({ text: '总结' })[0]
  assert.ok(summarize)
  await view.press(summarize)
  const fallback = view.findAll({ text: '发给本地 Agent' })[0]
  assert.ok(fallback)
  await view.press(fallback)

  assert.ok(view.find({ label: '总结提示词' }))
  assert.ok(view.find({ text: /没有找到可发送的 agent/ }))
  await view.unmount()
})

test('loads the next latest page into the same list', async () => {
  const host = mockHost({
    requests: {
      'feed.get': (input) =>
        input?.cursor
          ? {
              ...feed,
              items: [item({ id: 'hn-2', title: '第二页标题', source: 'hn' })],
              nextCursor: null,
            }
          : { ...feed, nextCursor: 'page-2' },
      'models.list': catalog,
      'summary.generate': (input) => summaryFor(input?.choice),
      'item.summarize': { sent: false, prompt: '', reason: 'no-agent' },
    },
  })
  const view = await mount(panel, { host })

  assert.ok(view.find({ text: '中文标题' }))
  const more = view.findAll({ text: '加载更多' })[0]
  assert.ok(more)
  await view.press(more)

  assert.ok(view.find({ text: '第二页标题' }))
  assert.ok(view.find({ text: '中文标题' }))
  assert.equal(view.find({ text: '加载更多' }), null)
  await view.unmount()
})

test('shows a callout when the feed request fails', async () => {
  const host = mockHost({
    requests: {
      'feed.get': () => {
        throw hostError('unavailable', '数据暂时不可用')
      },
      'models.list': catalog,
    },
  })
  const view = await mount(panel, { host })

  assert.ok(view.find({ text: /数据暂时不可用/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
