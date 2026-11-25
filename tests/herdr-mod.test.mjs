// Zero-dependency behavioral tests for herdr/jing-show/main.js.
// Stubs the host-provided `gpui-kit`, `gpui-base` and `herdr` modules via
// Node's module hooks so the real Herdr View class runs under `node --test`.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as moduleApi from 'node:module'

const hostState = {
  checking: false,
  shared: new Map(),
  notifications: [],
  scrollCalls: [],
}

function makeChain() {
  const proxy = new Proxy(() => proxy, {
    get(_target, prop) {
      if (prop === 'then') return undefined
      return () => proxy
    },
  })
  return proxy
}

const VIRTUAL_MODULES = {
  crypto: `export const randomUUID = () => '00000000-0000-4000-8000-000000000000';`,
  'fs/promises': `export const unlink = async () => {}; export const writeFile = async () => {};`,
  path: `export const join = (...parts) => parts.join('/');`,
  'gpui-kit': `
    export class View {}
    export const div = () => globalThis.__HERDR_TEST__.makeChain();
    export const image = () => globalThis.__HERDR_TEST__.makeChain();
  `,
  'gpui-base': `
    export const v_flex = () => globalThis.__HERDR_TEST__.makeChain();
    export const h_flex = () => globalThis.__HERDR_TEST__.makeChain();
    export const TextView = { markdown: () => globalThis.__HERDR_TEST__.makeChain() };
    let nextScrollId = 1;
    export const ScrollHandle = {
      new() {
        const id = nextScrollId++;
        return {
          id,
          scroll_to_item(index) {
            globalThis.__HERDR_TEST__.hostState.scrollCalls.push({ id, index });
          },
          release() { return true; },
        };
      },
    };
  `,
  herdr: `
    export const appHome = () => '/tmp';
    export const home = () => '/tmp';
    export const checking = () => globalThis.__HERDR_TEST__.hostState.checking;
    export const exec = async () => ({ code: 1, stdout: '', stderr: '' });
    export const focused = () => ({ tab: 'tab-1' });
    export const nextCommand = () => new Promise(() => {});
    export const notify = (msg) => globalThis.__HERDR_TEST__.hostState.notifications.push(msg);
    export const readTextFile = async () => '';
    export const shared = (key) => globalThis.__HERDR_TEST__.hostState.shared.get(key);
    export const setShared = (key, value) => {
      globalThis.__HERDR_TEST__.hostState.shared.set(key, value);
      return null;
    };
    export const theme = () => ({
      background: '#000',
      foreground: '#fff',
      terminal_foreground: '#fff',
      muted: '#aaa',
      dim: '#666',
      border: '#333',
      selected: '#222',
      hover: '#111',
      raised: '#111',
      accent: '#0af',
      accent_foreground: '#fff',
      ansi1: '#f00',
    });
  `,
}

globalThis.__HERDR_TEST__ = { hostState, makeChain }

if (typeof moduleApi.registerHooks === 'function') {
  moduleApi.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(VIRTUAL_MODULES, specifier)) {
        return { shortCircuit: true, url: `herdr-stub://${specifier}` }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.startsWith('herdr-stub://')) {
        const name = url.slice('herdr-stub://'.length)
        return {
          shortCircuit: true,
          format: 'module',
          source: VIRTUAL_MODULES[name],
        }
      }
      return nextLoad(url, context)
    },
  })
} else {
  const loaderSource = `
    const MODULES = ${JSON.stringify(VIRTUAL_MODULES)};
    export async function resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(MODULES, specifier)) {
        return { shortCircuit: true, url: 'herdr-stub://' + specifier };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url.startsWith('herdr-stub://')) {
        const name = url.slice('herdr-stub://'.length);
        return { shortCircuit: true, format: 'module', source: MODULES[name] };
      }
      return nextLoad(url, context);
    }
  `
  moduleApi.register(`data:text/javascript;base64,${Buffer.from(loaderSource).toString('base64')}`)
}

const { default: JingShow } = await import('../herdr/jing-show/main.js')

const NOW = new Date(2026, 10, 24, 17, 0, 0).getTime()

function makeItem(id, source = 'v2ex', overrides = {}) {
  return {
    id,
    source,
    title: `Title ${id}`,
    titleZh: `标题 ${id}`,
    brief: null,
    briefZh: null,
    body: null,
    bodyZh: null,
    url: `https://example.com/${id}`,
    publishedAt: NOW - 60_000,
    metrics: {},
    extra: {},
    isHot: false,
    ...overrides,
  }
}

function makeFeed(items, overrides = {}) {
  const bySource = {}
  for (const item of items) {
    bySource[item.source] = (bySource[item.source] ?? 0) + 1
  }
  return {
    items,
    nextCursor: null,
    counts: { all: items.length, bySource },
    totals: { hot: 10, rising: 10 },
    lastUpdated: NOW,
    dataVersion: 1,
    ...overrides,
  }
}

function makeResponse(body, status = 200) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  }
}

function makeCx() {
  let notifies = 0
  const timers = []
  const cx = {
    focus_handle() {
      return { focus() {} }
    },
    notify() {
      notifies++
    },
    timer: {
      every(ms, fn) {
        timers.push({ ms, fn })
        return { cancel() {}, is_done: () => false }
      },
      after(ms, fn) {
        timers.push({ ms, fn })
        return { cancel() {}, is_done: () => false }
      },
    },
    spawn(fn) {
      let done = false
      Promise.resolve()
        .then(() => fn(cx))
        .catch(() => {})
        .finally(() => {
          done = true
        })
      return { cancel() {}, is_done: () => done }
    },
    async flush(rounds = 20) {
      for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    get notifies() {
      return notifies
    },
    timers,
  }
  return cx
}

let originalFetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  hostState.checking = false
  hostState.shared.clear()
  hostState.notifications.length = 0
  hostState.scrollCalls.length = 0
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Herdr JingShow mod: auto-fill and tab preloading', () => {
  it('auto-loads the next page when switching source yields too few items', async () => {
    const calls = []
    const allItems = Array.from({ length: 20 }, (_, i) =>
      makeItem(`all-${i}`, i < 2 ? 'hn' : 'x'),
    )
    const hnPage1 = [makeItem('hn-1', 'hn'), makeItem('hn-2', 'hn')]
    const hnPage2 = Array.from({ length: 18 }, (_, i) => makeItem(`hn-p2-${i}`, 'hn'))

    globalThis.fetch = async (url) => {
      const parsed = new URL(url)
      calls.push(parsed)
      const view = parsed.searchParams.get('view')
      const source = parsed.searchParams.get('source')
      const cursor = parsed.searchParams.get('cursor')
      if (view === 'latest' && source === 'all') {
        return makeResponse(makeFeed(allItems, { nextCursor: 'all-c2' }))
      }
      if (view === 'latest' && source === 'hn') {
        return cursor
          ? makeResponse(makeFeed(hnPage2, { nextCursor: 'hn-c3' }))
          : makeResponse(makeFeed(hnPage1, { nextCursor: 'hn-c2' }))
      }
      return makeResponse(makeFeed([makeItem(`${view}-${source}-1`, source === 'all' ? 'x' : source)]))
    }

    const cx = makeCx()
    const mod = new JingShow()
    mod.init({}, cx)
    await cx.flush()

    mod.selectSource('hn', cx)
    // Immediate preview from cached latest:all avoids a blank screen while scoped page 1 loads.
    assert.equal(mod.items.length, 2)
    await cx.flush()

    assert.equal(mod.source, 'hn')
    assert.equal(mod.items.length, 20)
    assert.equal(mod.nextCursor, 'hn-c3')
    assert.ok(
      calls.some(
        (u) =>
          u.searchParams.get('view') === 'latest' &&
          u.searchParams.get('source') === 'hn' &&
          u.searchParams.get('cursor') === 'hn-c2',
      ),
      'should automatically request the next cursor page for the short source',
    )
  })

  it('auto-loads the next page when switching tab to a short latest view and respects AUTO_FILL_MAX_PAGES', async () => {
    const calls = []
    let page = 0
    globalThis.fetch = async (url) => {
      const parsed = new URL(url)
      calls.push(parsed)
      const view = parsed.searchParams.get('view')
      const source = parsed.searchParams.get('source')
      const cursor = parsed.searchParams.get('cursor')
      if (view === 'hot' && source === 'github') {
        return makeResponse(makeFeed([makeItem('gh-hot-1', 'github')]))
      }
      if (view === 'rising' && source === 'github') {
        return makeResponse(makeFeed([makeItem('gh-rising-1', 'github')]))
      }
      if (view === 'latest' && source === 'github') {
        page++
        return makeResponse(
          makeFeed([makeItem(`gh-l-${cursor ?? 'p1'}`, 'github')], {
            nextCursor: `c-${page + 1}`,
          }),
        )
      }
      return makeResponse(makeFeed([]))
    }

    hostState.shared.set('jing-show.session', { view: 'hot', source: 'github', selectedId: null })
    const cx = makeCx()
    const mod = new JingShow()
    mod.init({}, cx)
    await cx.flush()

    // Background preload of latest:github already fetched page 1 + 3 auto-fill pages (4 total).
    mod.setView('latest', cx)
    assert.equal(mod.loading, false)
    assert.equal(mod.items.length, 4)

    const latestCalls = calls.filter(
      (u) => u.searchParams.get('view') === 'latest' && u.searchParams.get('source') === 'github',
    )
    assert.equal(latestCalls.length, 4, 'page 1 plus AUTO_FILL_MAX_PAGES (3) follow-up pages')
  })

  it('preloads sibling tabs in background for 0ms synchronous switching and preserves state', async () => {
    const calls = []
    const latestItems = Array.from({ length: 20 }, (_, i) => makeItem(`l-${i}`, 'v2ex'))
    const hotItems = Array.from({ length: 15 }, (_, i) => makeItem(`h-${i}`, 'hn'))
    const risingItems = Array.from({ length: 15 }, (_, i) => makeItem(`r-${i}`, 'x'))

    globalThis.fetch = async (url) => {
      const parsed = new URL(url)
      calls.push(parsed)
      const view = parsed.searchParams.get('view')
      if (view === 'hot') return makeResponse(makeFeed(hotItems))
      if (view === 'rising') return makeResponse(makeFeed(risingItems))
      return makeResponse(makeFeed(latestItems, { nextCursor: 'l-c2' }))
    }

    const cx = makeCx()
    const mod = new JingShow()
    mod.init({}, cx)
    await cx.flush()

    // Initial load fetched latest and preloaded hot + rising.
    assert.equal(calls.length, 3)
    mod.render(cx)

    // Move selection in latest, then switch to hot -> rising -> back to latest.
    mod.move(3, cx)
    assert.equal(mod.selected, 3)

    mod.setView('hot', cx)
    assert.equal(mod.loading, false, 'preloaded hot tab renders synchronously without loading state')
    assert.equal(mod.items[0].id, 'h-0')
    assert.equal(calls.length, 3, 'no extra network call on preloaded tab switch')
    mod.render(cx)

    mod.setView('rising', cx)
    assert.equal(mod.loading, false)
    assert.equal(mod.items[0].id, 'r-0')
    assert.equal(calls.length, 3)
    mod.render(cx)

    mod.setView('latest', cx)
    assert.equal(mod.loading, false)
    assert.equal(mod.items[0].id, 'l-0')
    assert.equal(mod.selected, 3, 'restores previous selection in latest')
    assert.equal(calls.length, 3)

    // Each tab owns an independent ScrollHandle.
    assert.notEqual(mod.scrolls.latest.id, mod.scrolls.hot.id)
    assert.notEqual(mod.scrolls.hot.id, mod.scrolls.rising.id)
  })

  it('deduplicates an in-flight background preload when the user switches to that tab early', async () => {
    let resolveHot
    const calls = []
    globalThis.fetch = async (url) => {
      const parsed = new URL(url)
      calls.push(parsed)
      const view = parsed.searchParams.get('view')
      if (view === 'hot') {
        await new Promise((resolve) => {
          resolveHot = resolve
        })
        return makeResponse(makeFeed([makeItem('hot-1', 'hn')]))
      }
      return makeResponse(makeFeed(Array.from({ length: 20 }, (_, i) => makeItem(`${view}-${i}`, 'v2ex'))))
    }

    const cx = makeCx()
    const mod = new JingShow()
    mod.init({}, cx)
    // Wait until latest resolves and background preload for hot starts.
    for (let i = 0; i < 20 && !resolveHot; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.ok(resolveHot, 'background preload for hot should be in flight')

    // Switch to hot BEFORE preload completes: must share the in-flight request.
    mod.setView('hot', cx)
    const hotCalls = calls.filter((u) => u.searchParams.get('view') === 'hot')
    assert.equal(hotCalls.length, 1, 'should reuse the in-flight preload promise')

    resolveHot()
    await cx.flush()
    assert.equal(mod.view, 'hot')
    assert.equal(mod.items[0].id, 'hot-1')
    assert.equal(mod.loading, false)
  })

  it('uses stale-while-revalidate when a higher dataVersion arrives and caches legitimately empty views', async () => {
    let version = 1
    const calls = []
    globalThis.fetch = async (url) => {
      const parsed = new URL(url)
      calls.push(parsed)
      const view = parsed.searchParams.get('view')
      if (view === 'hot') {
        return makeResponse(
          makeFeed(version === 1 ? [makeItem('hot-v1', 'hn')] : [makeItem('hot-v2', 'hn')], {
            dataVersion: version,
            lastUpdated: NOW + version * 1000,
          }),
        )
      }
      if (view === 'rising') {
        // Legitimately empty view (e.g. a source with no rising items).
        return makeResponse(makeFeed([], { dataVersion: version, lastUpdated: NOW + version * 1000 }))
      }
      return makeResponse(
        makeFeed(
          Array.from({ length: 20 }, (_, i) => makeItem(`l-v${version}-${i}`, 'v2ex')),
          { dataVersion: version, lastUpdated: NOW + version * 1000 },
        ),
      )
    }

    const cx = makeCx()
    const mod = new JingShow()
    mod.init({}, cx)
    await cx.flush()

    // Legitimately empty rising view hits cache directly without refetching.
    const countBeforeRising = calls.length
    mod.setView('rising', cx)
    assert.equal(mod.items.length, 0)
    assert.equal(mod.loading, false)
    assert.equal(calls.length, countBeforeRising)

    // Back to latest, force manual refresh with newer dataVersion = 2.
    mod.setView('latest', cx)
    version = 2
    mod.fetch(cx, { quiet: false, force: true })
    await cx.flush()
    assert.equal(mod.dataVersion, 2)

    // Simulate a stale cached hot entry (v1) to verify SWR shows old items immediately without blanking.
    mod.feedCache.set('hot:all', {
      view: 'hot',
      source: 'all',
      items: [makeItem('hot-v1', 'hn')],
      pageCounts: { all: 1, bySource: { hn: 1 } },
      nextCursor: null,
      lastUpdated: NOW + 1000,
      dataVersion: 1,
      fetchedAt: Date.now(),
      selectedId: null,
      truncated: false,
    })

    mod.setView('hot', cx)
    assert.equal(mod.items[0].id, 'hot-v1', 'SWR renders stale cached items immediately')
    assert.equal(mod.loading, true, 'quiet revalidation runs in background')
    await cx.flush()
    assert.equal(mod.items[0].id, 'hot-v2', 'revalidation updates to the new revision')
    assert.equal(mod.loading, false)
  })

  it('prevents late responses from an old tab from corrupting the active tab', async () => {
    let resolvePage2
    const calls = []
    globalThis.fetch = async (url) => {
      const parsed = new URL(url)
      calls.push(parsed)
      const view = parsed.searchParams.get('view')
      const cursor = parsed.searchParams.get('cursor')
      if (view === 'latest' && cursor) {
        await new Promise((resolve) => {
          resolvePage2 = resolve
        })
        return makeResponse(makeFeed([makeItem('late-latest-item', 'v2ex')]))
      }
      if (view === 'hot') {
        return makeResponse(makeFeed([makeItem('hot-only', 'hn')]))
      }
      if (view === 'rising') {
        return makeResponse(makeFeed([makeItem('rising-only', 'x')]))
      }
      return makeResponse(
        makeFeed(Array.from({ length: 20 }, (_, i) => makeItem(`l-${i}`, 'v2ex')), {
          nextCursor: 'c-2',
        }),
      )
    }

    const cx = makeCx()
    const mod = new JingShow()
    mod.init({}, cx)
    await cx.flush()

    // Start loadMore on latest, then switch to cached hot BEFORE page 2 resolves.
    mod.loadMore(cx)
    for (let i = 0; i < 20 && !resolvePage2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.ok(resolvePage2)

    mod.setView('hot', cx)
    assert.equal(mod.items[0].id, 'hot-only')

    resolvePage2()
    await cx.flush()
    assert.equal(mod.view, 'hot')
    assert.deepEqual(mod.items.map((item) => item.id), ['hot-only'])
  })

  it('never starts network requests or prefetches when checking() is true', async () => {
    hostState.checking = true
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return makeResponse(makeFeed([]))
    }

    const cx = makeCx()
    const mod = new JingShow()
    mod.init({}, cx)
    mod.render(cx)
    await cx.flush()

    assert.equal(calls, 0)
    assert.equal(cx.timers.length, 0)
  })
})
