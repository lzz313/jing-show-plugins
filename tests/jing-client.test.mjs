// Zero-dependency regression tests for shared/jing-client.mjs.
// Run with `npm test` (node --test); no packages are installed.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  NO_BRIEF_RE,
  appendFeedPage,
  decodeEntities,
  fetchFeed,
  finiteNumber,
  formatClock,
  formatCompactNumber,
  normalizeLimit,
  stripHtml,
  toFeedView,
} from '../shared/jing-client.mjs'

const NOW = new Date(2026, 10, 16, 16, 0, 0).getTime()

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function item(overrides = {}) {
  return {
    id: 'item-1',
    source: 'v2ex',
    title: 'English title',
    titleZh: null,
    brief: null,
    briefZh: null,
    body: null,
    bodyZh: null,
    url: 'https://example.com/post',
    publishedAt: NOW - 60_000,
    metrics: {},
    extra: {},
    isHot: false,
    ...overrides,
  }
}

function feed(items, overrides = {}) {
  return {
    items,
    nextCursor: null,
    counts: {
      all: items.length,
      bySource: Object.fromEntries(items.map((entry) => [entry.source, 1])),
    },
    totals: { hot: 0, rising: 0 },
    lastUpdated: NOW - 1_000,
    dataVersion: 1,
    ...overrides,
  }
}

describe('finiteNumber', () => {
  it('treats null, empty strings and booleans as absent', () => {
    for (const value of [null, undefined, '', '   ', false, true]) {
      assert.equal(finiteNumber(value), undefined)
    }
  })

  it('keeps real zeros and numeric strings', () => {
    assert.equal(finiteNumber(0), 0)
    assert.equal(finiteNumber('12'), 12)
    assert.equal(finiteNumber(Number.NaN), undefined)
  })
})

describe('normalizeLimit', () => {
  it('never coerces an absent value to one item', () => {
    assert.equal(normalizeLimit(null), undefined)
    assert.equal(normalizeLimit(undefined), undefined)
    assert.equal(normalizeLimit(''), undefined)
    assert.equal(normalizeLimit(false), undefined)
  })

  it('clamps a real request', () => {
    assert.equal(normalizeLimit(0), 1)
    assert.equal(normalizeLimit('12'), 12)
    assert.equal(normalizeLimit(999), 50)
  })
})

describe('NO_BRIEF_RE', () => {
  it('matches the notes the web app hides', () => {
    assert.equal(NO_BRIEF_RE.test('无'), true)
    assert.equal(NO_BRIEF_RE.test('（无）'), true)
    assert.equal(NO_BRIEF_RE.test('因文中信息量不足，暂无法概括。'), true)
    assert.equal(NO_BRIEF_RE.test('正文为空'), true)
    assert.equal(NO_BRIEF_RE.test('这是一条正常摘要'), false)
  })

  it('drops a note only after the HTML around it is cleaned', () => {
    const view = toFeedView(
      feed([item({ briefZh: '<p> 信息不足，无法概括。 </p>', bodyZh: '正文' })]),
      { now: NOW },
    )
    assert.equal(view.items[0].summary, '正文')
  })
})

describe('decodeEntities', () => {
  it('decodes named, decimal and hex references', () => {
    assert.equal(decodeEntities('&amp; &#38; &#x26;'), '& & &')
    assert.equal(decodeEntities('&#128512;'), '😀')
  })

  it('does not read trailing letters as part of a decimal reference', () => {
    assert.equal(decodeEntities('&#38abc;'), '&#38abc;')
  })

  it('leaves invalid code points and lone surrogates alone', () => {
    assert.equal(decodeEntities('&#0;'), '&#0;')
    assert.equal(decodeEntities('&#xD800;'), '&#xD800;')
    assert.equal(decodeEntities('&#x110000;'), '&#x110000;')
    assert.equal(decodeEntities('&unknown;'), '&unknown;')
  })
})

describe('stripHtml', () => {
  it('strips real tags', () => {
    assert.equal(stripHtml('<p>a<br>b</p>'), 'a b')
    assert.equal(stripHtml('<a href="https://example.com">link</a>'), 'link')
    assert.equal(stripHtml('<script>alert(1)</script>ok'), 'ok')
  })

  it('keeps technical angle brackets that are not markup', () => {
    assert.equal(stripHtml('Vec<u8>'), 'Vec<u8>')
    assert.equal(stripHtml('Vec<T>'), 'Vec<T>')
    assert.equal(stripHtml('x < 1 && y > 0'), 'x < 1 && y > 0')
  })

  it('decodes escaped markup after removing tags', () => {
    assert.equal(stripHtml('&lt;b&gt;literal&lt;/b&gt;'), '<b>literal</b>')
  })
})

describe('fetchFeed query shapes', () => {
  it('queries a single latest source directly instead of filtering source=all', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(new URL(url))
      return response(feed([item({ id: 'v2ex-1' }), item({ id: 'x-1', source: 'x' })]))
    }

    const data = await fetchFeed({ view: 'latest', source: 'v2ex', fetchImpl, now: NOW })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].searchParams.get('view'), 'latest')
    assert.equal(calls[0].searchParams.get('source'), 'v2ex')
    assert.deepEqual(data.items.map((entry) => entry.id), ['v2ex-1'])
    assert.equal(data.fallback, true)
    assert.equal(data.pageCounts.all, 1)
    assert.equal(data.pageCounts.bySource.v2ex, 1)
    assert.equal(data.counts.all, 2)
  })

  it('queries a ranking view for the source directly', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(new URL(url))
      return response(feed([item({ id: 'r-1', source: 'reddit' })]))
    }

    const data = await fetchFeed({ view: 'hot', source: 'reddit', fetchImpl, now: NOW })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].searchParams.get('view'), 'hot')
    assert.equal(calls[0].searchParams.get('source'), 'reddit')
    assert.deepEqual(data.items.map((entry) => entry.id), ['r-1'])
    assert.equal(data.fallback, true)
  })

  it('queries the source directly when paging with a cursor', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(new URL(url))
      return response(feed([item({ id: 'v-2' })]))
    }

    const data = await fetchFeed({
      view: 'latest',
      source: 'v2ex',
      cursor: 'page-2',
      fetchImpl,
      now: NOW,
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].searchParams.get('source'), 'v2ex')
    assert.equal(calls[0].searchParams.get('cursor'), 'page-2')
    assert.deepEqual(data.items.map((entry) => entry.id), ['v-2'])
  })

  it('automatically fetches follow-up cursor pages when minItems is not yet met', async () => {
    const calls = []
    const pages = {
      '': feed([item({ id: 'gh-1', source: 'github' }), item({ id: 'gh-2', source: 'github' })], {
        nextCursor: 'c-2',
      }),
      'c-2': feed(
        [
          item({ id: 'gh-2', source: 'github' }),
          item({ id: 'gh-3', source: 'github' }),
          item({ id: 'gh-4', source: 'github' }),
        ],
        { nextCursor: 'c-3' },
      ),
      'c-3': feed([item({ id: 'gh-5', source: 'github' })], { nextCursor: 'c-4' }),
    }
    const fetchImpl = async (url) => {
      const parsed = new URL(url)
      calls.push(parsed)
      const cursor = parsed.searchParams.get('cursor') ?? ''
      return response(pages[cursor])
    }

    const data = await fetchFeed({
      view: 'latest',
      source: 'github',
      minItems: 5,
      maxPages: 3,
      fetchImpl,
      now: NOW,
    })
    assert.equal(calls.length, 3)
    assert.deepEqual(
      calls.map((entry) => entry.searchParams.get('cursor')),
      [null, 'c-2', 'c-3'],
    )
    assert.deepEqual(
      data.items.map((entry) => entry.id),
      ['gh-1', 'gh-2', 'gh-3', 'gh-4', 'gh-5'],
    )
    assert.equal(data.nextCursor, 'c-4')
    assert.equal(data.pageCounts.all, 5)
    assert.equal(data.pageCounts.bySource.github, 5)
  })

  it('stops auto-fill when maxPages is reached, cursor stalls, or follow-up fails', async () => {
    let calls = 0
    const stalled = await fetchFeed({
      view: 'latest',
      source: 'v2ex',
      minItems: 10,
      maxPages: 3,
      fetchImpl: async () => {
        calls++
        return response(feed([item({ id: 'v-1' })], { nextCursor: 'same-cursor' }))
      },
      now: NOW,
    })
    assert.equal(calls, 2)
    assert.deepEqual(stalled.items.map((entry) => entry.id), ['v-1'])

    let failedCalls = 0
    const resilient = await fetchFeed({
      view: 'latest',
      source: 'v2ex',
      minItems: 10,
      maxPages: 3,
      fetchImpl: async (url) => {
        failedCalls++
        if (new URL(url).searchParams.get('cursor')) {
          return response({}, 503)
        }
        return response(feed([item({ id: 'v-1' })], { nextCursor: 'c-2' }))
      },
      now: NOW,
    })
    assert.equal(failedCalls, 2)
    assert.deepEqual(resilient.items.map((entry) => entry.id), ['v-1'])
    assert.equal(resilient.nextCursor, 'c-2')
  })
})

describe('appendFeedPage', () => {
  it('deduplicates appended items, updates pageCounts and respects maxItems', () => {
    const first = toFeedView(
      feed([item({ id: 'a', source: 'v2ex' }), item({ id: 'b', source: 'hn' })], {
        nextCursor: 'c-2',
      }),
      { now: NOW },
    )
    const second = toFeedView(
      feed(
        [
          item({ id: 'b', source: 'hn' }),
          item({ id: 'c', source: 'hn' }),
          item({ id: 'd', source: 'github' }),
        ],
        { nextCursor: 'c-3', dataVersion: 2 },
      ),
      { now: NOW + 1_000 },
    )
    const merged = appendFeedPage(first, second, 3)
    assert.deepEqual(merged.items.map((entry) => entry.id), ['a', 'b', 'c'])
    assert.deepEqual(merged.pageCounts, { all: 3, bySource: { v2ex: 1, hn: 2 } })
    assert.equal(merged.nextCursor, 'c-3')
    assert.equal(merged.dataVersion, 2)
  })
})

describe('feed view mapping', () => {
  it('cleans each summary candidate before choosing one', () => {
    const view = toFeedView(
      feed([item({ brief: 'https://example.com/a', body: 'The actual body text' })]),
      { now: NOW },
    )
    assert.equal(view.items[0].summary, 'The actual body text')
  })

  it('keeps an unknown source id instead of aliasing it to x', () => {
    const view = toFeedView(feed([item({ source: 'mastodon' })]), { now: NOW })
    const entry = view.items[0]
    assert.equal(entry.source, 'mastodon')
    assert.equal(entry.sourceName, 'mastodon')
    assert.equal(entry.sourceShort, 'mastodon')
  })

  it('omits a null metric instead of printing zero', () => {
    const view = toFeedView(
      feed([item({ source: 'x', metrics: { views: null, likes: 3 } })]),
      { now: NOW },
    )
    assert.equal(view.items[0].metricLabel, '赞 3')
  })
})

describe('number and time formatting', () => {
  it('keeps every compact number inside its unit', () => {
    assert.equal(formatCompactNumber(999), '999')
    assert.equal(formatCompactNumber(1_500), '1.5k')
    assert.equal(formatCompactNumber(9_999), '1万')
    assert.equal(formatCompactNumber(12_000), '1.2万')
    assert.equal(formatCompactNumber(99_999_999), '1亿')
    assert.equal(formatCompactNumber(100_000_000), '1亿')
    assert.equal(formatCompactNumber(Number.NaN), '')
  })

  it('does not print NaN clocks for an invalid timestamp', () => {
    assert.equal(formatClock(Number.NaN), '')
    assert.equal(formatClock(Number.POSITIVE_INFINITY), '')
  })
})
