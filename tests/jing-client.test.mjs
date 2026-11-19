// Zero-dependency regression tests for shared/jing-client.mjs.
// Run with `npm test` (node --test); no packages are installed.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  NO_BRIEF_RE,
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
  it('filters the first latest page locally and keeps the counts', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(new URL(url))
      return response(feed([item({ id: 'v2ex-1' }), item({ id: 'x-1', source: 'x' })]))
    }

    const data = await fetchFeed({ view: 'latest', source: 'v2ex', fetchImpl, now: NOW })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].searchParams.get('source'), 'all')
    assert.deepEqual(data.items.map((entry) => entry.id), ['v2ex-1'])
    assert.equal(data.fallback, false)
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

  it('falls back to a scoped request when the first page has no item', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(new URL(url))
      return calls.length === 1
        ? response(feed([item({ id: 'x-1', source: 'x' })]))
        : response(feed([item({ id: 'gh-1', source: 'github' })]))
    }

    const data = await fetchFeed({ view: 'latest', source: 'github', fetchImpl, now: NOW })
    assert.equal(calls.length, 2)
    assert.equal(calls[1].searchParams.get('source'), 'github')
    assert.deepEqual(data.items.map((entry) => entry.id), ['gh-1'])
    assert.equal(data.fallback, true)
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
