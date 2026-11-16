// `orca plugin check` renders the panel once per scenario. `requests` stands in for
// the worker, so checks stay offline and cover the narrow-sidebar states.
import { defineCheck, hostError } from 'orca/testing'
import type { FeedItemView, FeedViewData } from './vendor/jing-client.mjs'
import type { ModelCatalog, SummaryChoice } from './protocol'

const item = (overrides: Partial<FeedItemView>): FeedItemView => ({
  id: 'item',
  source: 'v2ex',
  sourceName: 'V2EX',
  sourceShort: 'V2EX',
  sourceColor: '#4b5563',
  title: '一个足够长的标题，用来看窄侧栏里的截断',
  titleOriginal: '',
  summary: '摘要也控制在两行以内，帮助确认卡片高度和按钮位置。',
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
  items: [
    item({ id: 'v2ex-1' }),
    item({
      id: 'hn-1',
      source: 'hn',
      sourceName: 'Hacker News',
      sourceShort: 'Hacker News',
      sourceColor: '#f26522',
      title: 'A Show HN for a tiny feed reader',
      titleOriginal: 'A Show HN for a tiny feed reader',
      summary: 'The author explains what changed in this release and why.',
      summaryOriginal: 'The author explains what changed in this release and why.',
      url: 'https://news.ycombinator.com/item?id=1',
      metricLabel: '120 分 · 45 评论',
      timeLabel: '半小时前',
    }),
    item({
      id: 'github-1',
      source: 'github',
      sourceName: 'GitHub Trending',
      sourceShort: 'GitHub',
      sourceColor: '#24292f',
      title: 'org/repo',
      summary: '今日 +88 stars · 12.3k stars',
      metricLabel: '今日 +88',
      isHot: false,
    }),
  ],
  counts: { all: 3, bySource: { v2ex: 1, hn: 1, github: 1 } },
  pageCounts: { all: 3, bySource: { v2ex: 1, hn: 1, github: 1 } },
  totals: { hot: 3, rising: 4 },
  lastUpdated: Date.now() - 30_000,
  dataVersion: 42,
  nextCursor: null,
  fetchedAt: Date.now(),
  fallback: false,
}

const empty: FeedViewData = {
  ...feed,
  items: [],
  counts: { all: 0, bySource: {} },
  pageCounts: { all: 0, bySource: {} },
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
    text: '要点一：这条资讯的核心变化。\n\n要点二：它为什么值得关注。',
    model: choice?.model ?? catalog.defaultModel,
    label: choice?.label ?? catalog.defaultLabel,
    effort: choice?.effort ?? catalog.defaultEffort,
  }
}

export default defineCheck({
  feed: {
    requests: {
      'feed.get': feed,
      'models.list': catalog,
      'summary.generate': (input) => summaryFor(input?.choice),
      'item.summarize': { sent: true, prompt: '', agent: 'Claude Code' },
    },
  },
  empty: {
    requests: {
      'feed.get': empty,
      'models.list': catalog,
      'summary.generate': (input) => summaryFor(input?.choice),
      'item.summarize': { sent: false, prompt: '请用中文总结这条资讯。', reason: 'no-agent' },
    },
  },
  error: {
    requests: {
      'feed.get': () => {
        throw hostError('unavailable', '数据暂时不可用')
      },
      'models.list': catalog,
    },
  },
})
