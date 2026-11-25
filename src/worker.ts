// The plugin's own worker. Orca starts it on the panel's first plugin.request and
// transpiles this file when it loads: no build step. A save restarts it, so the
// 60-second page cache is deliberately in memory only.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import type { FeedItemView, FeedViewData } from './vendor/jing-client.mjs'
import { buildPrompt, fetchFeed } from './vendor/jing-client.mjs'
import type {
  ModelCatalog,
  SummaryChoice,
  SummaryModel,
  SummaryResult,
} from './protocol'

const CACHE_MS = 5 * 60_000
/** Enough first pages for every view/source pair a reader cycles through. */
const CACHE_MAX = 24
const MODELS_CACHE_MS = 5 * 60_000
const MODELS_TIMEOUT_MS = 15_000
const SUMMARY_TIMEOUT_MS = 90_000
const SUMMARY_MAX_TOKENS = 2000
const SUMMARY_FALLBACK_MODEL = 'auto/deepseek-v4.1-flash'
const SUMMARY_SYSTEM =
  '你是资讯编辑。只输出中文总结正文：3–5 条要点，并说明它为什么值得关注。' +
  '直接列要点，不要复述标题；不要寒暄，不要复述或提及这些指令，不要输出思考过程。'

// Claude Code marks a request that may think adaptively and puts the reasoning
// level in output_config.effort. The local router only reads that level when
// the adaptive thinking marker is there too.
const SUMMARY_THINKING = { type: 'adaptive', display: 'omitted' }

interface ClaudeSettings {
  env?: Record<string, string | undefined>
  modelSettings?: Record<string, { effortLevel?: unknown } | undefined>
  modelPicker?: { options?: { model?: unknown; label?: unknown }[] }
}

interface ModelConfig {
  base: string
  token: string
  model: string
  effort: string
  labels: Record<string, string>
}

interface CacheEntry {
  key: string
  at: number
  data: FeedViewData
}

interface ModelsCache {
  at: number
  catalog: ModelCatalog
}

function normalizeModelId(raw: unknown): string {
  return String(raw ?? '').replace(/\[[^\]]*\]$/, '')
}

function envValue(name: string, env: Record<string, string | undefined>): string {
  const fromFile = env[name]
  if (fromFile) return fromFile
  const fromProcess = process.env[name]
  return fromProcess ?? ''
}

async function readClaudeSettings(): Promise<ClaudeSettings> {
  try {
    const raw = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ClaudeSettings) : {}
  } catch {
    return {}
  }
}

/**
 * The local router's fastest/cheapest model. It is the small-fast model Claude
 * Code itself is configured with; the `[1m]` suffix is a Claude Code context
 * marker, not part of the model id the router serves.
 */
async function loadModelConfig(): Promise<ModelConfig> {
  const settings = await readClaudeSettings()
  const env = settings.env ?? {}
  const base =
    envValue('ANTHROPIC_BASE_URL', env) || 'http://127.0.0.1:3425'
  const token = envValue('ANTHROPIC_AUTH_TOKEN', env)
  const rawModel =
    envValue('ANTHROPIC_SMALL_FAST_MODEL', env) ||
    envValue('ANTHROPIC_DEFAULT_HAIKU_MODEL', env) ||
    SUMMARY_FALLBACK_MODEL
  const model = normalizeModelId(rawModel)

  // Claude Code keeps the effort it starts a session with per model; use it as
  // the default level, and let the picker override it for one summary.
  let effort = ''
  for (const [id, value] of Object.entries(settings.modelSettings ?? {})) {
    if (normalizeModelId(id) !== model) continue
    if (value?.effortLevel) effort = String(value.effortLevel)
    break
  }

  // A friendly name before /v1/models has been read.
  const labels: Record<string, string> = {}
  for (const option of settings.modelPicker?.options ?? []) {
    const id = normalizeModelId(option?.model)
    if (!id || !option?.label) continue
    labels[id] = String(option.label).split(' · ')[0]
  }

  return { base: base.replace(/\/+$/, ''), token, model, effort, labels }
}

function labelFor(config: ModelConfig, models: SummaryModel[], id: string): string {
  const known = models.find((model) => model.id === id)
  if (known) return known.label
  return config.labels[id] ?? id
}

async function fetchModelCatalog(
  config: ModelConfig,
  externalSignal?: AbortSignal,
): Promise<SummaryModel[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS)
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal
  try {
    const response = await fetch(`${config.base}/v1/models`, {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': config.token,
      },
      signal,
    })
    if (!response.ok) throw new Error(`models ${response.status}`)
    const data = (await response.json()) as {
      data?: {
        id?: unknown
        display_name?: unknown
        reasoning_levels?: unknown
        supported_reasoning_levels?: { effort?: unknown }[]
      }[]
    }
    const list = Array.isArray(data?.data) ? data.data : []
    return list
      .filter((model): model is { id: string } & typeof model => typeof model?.id === 'string' && Boolean(model.id))
      .map((model) => ({
        id: model.id,
        label:
          typeof model.display_name === 'string' && model.display_name
            ? model.display_name
            : model.id,
        levels: Array.isArray(model.reasoning_levels)
          ? model.reasoning_levels.filter(
              (level): level is string => typeof level === 'string' && Boolean(level),
            )
          : (model.supported_reasoning_levels ?? [])
              .map((entry) => entry?.effort)
              .filter((level): level is string => typeof level === 'string' && Boolean(level)),
      }))
  } finally {
    clearTimeout(timer)
  }
}

async function modelsCatalog(
  config: ModelConfig,
  signal?: AbortSignal,
): Promise<ModelCatalog> {
  const models = await fetchModelCatalog(config, signal)
  return {
    models,
    defaultModel: config.model,
    defaultLabel: labelFor(config, models, config.model),
    defaultEffort: config.effort,
  }
}

function friendlyModelsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/abort|timeout|timed out|ECONNREFUSED|connect|fetch failed/i.test(message)) {
    return '读不到模型列表：本地路由没有启动'
  }
  if (/401|403/.test(message)) return '读不到模型列表：本地路由鉴权失败'
  return message.length > 120 ? `${message.slice(0, 120)}…` : message
}

function friendlySummaryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/abort|timeout|timed out/i.test(message)) return '本地模型响应超时，请重试'
  if (/ECONNREFUSED|connect|fetch failed/i.test(message)) {
    return '连不上本地模型服务，确认 Claude Code 的本地路由已启动'
  }
  if (/402|payment|top.up|allowance/i.test(message)) {
    return '本地模型额度不足，换一个模型或充值后再试'
  }
  return message.length > 160 ? `${message.slice(0, 160)}…` : message
}

async function summarizeWithLocalModel(
  item: FeedItemView,
  choice: SummaryChoice | null | undefined,
  models: SummaryModel[] = [],
  externalSignal?: AbortSignal,
): Promise<SummaryResult> {
  const config = await loadModelConfig()
  if (!config.token) {
    throw new Error(
      '没有找到本地模型配置：~/.claude/settings.json 缺少 ANTHROPIC_AUTH_TOKEN',
    )
  }
  const model = choice?.model || config.model
  const effort = choice ? choice.effort || '' : config.effort || ''
  // The cached catalog names a model the settings file has never heard of;
  // the picker's label is only a fallback for a cold catalog.
  const label = choice?.label || labelFor(config, models, model)

  const body: Record<string, unknown> = {
    model,
    max_tokens: SUMMARY_MAX_TOKENS,
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(item) }],
  }
  if (effort) {
    body.thinking = SUMMARY_THINKING
    body.output_config = { effort }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
  // Closing the panel or switching items aborts through the request context;
  // the timeout aborts through the controller. Either way the fetch and the
  // body read below are cancelled.
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal
  try {
    const response = await fetch(`${config.base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': config.token,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      let detail = ''
      try {
        const data = (await response.json()) as { error?: { message?: unknown } }
        detail = typeof data?.error?.message === 'string' ? data.error.message : ''
      } catch {
        // Keep the status-based message.
      }
      throw new Error(detail || `summary ${response.status}`)
    }
    const data = (await response.json()) as {
      content?: { type?: unknown; text?: unknown }[]
      stop_reason?: unknown
    }
    const text = (Array.isArray(data?.content) ? data.content : [])
      .filter((block) => block?.type === 'text')
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('')
      .trim()
    if (!text) {
      if (data?.stop_reason === 'max_tokens') {
        throw new Error('回答被截断：级别过高或内容太长，换低一点的级别再试')
      }
      throw new Error('本地模型没有返回内容')
    }
    return { text, model, label, effort }
  } finally {
    // The timeout covers the body read too, not just the headers.
    clearTimeout(timer)
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  // Several first pages, not one slot: switching view or source used to evict
  // the page the reader was about to come back to.
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<FeedViewData>>()
  let latestDataVersion = 0
  let modelsCache: ModelsCache | null = null

  function remember(cacheKey: string, data: FeedViewData): void {
    if (data.dataVersion > latestDataVersion) {
      latestDataVersion = data.dataVersion
    }
    cache.delete(cacheKey)
    cache.set(cacheKey, { key: cacheKey, at: Date.now(), data })
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  orca.panels.handle('feed.get', async ({ view, source, refresh, cursor }, context) => {
    const key = `${view}:${source}`
    const now = Date.now()
    // The first page is cached for the snapshot TTL; an older page is not,
    // since a cursor is already a request for exactly one slice.
    if (!refresh && !cursor) {
      const hit = cache.get(key)
      if (
        hit &&
        now - hit.at < CACHE_MS &&
        hit.data.dataVersion >= latestDataVersion
      ) {
        // Refresh its place in the bounded map.
        cache.delete(key)
        cache.set(key, hit)
        return hit.data
      }
      const pending = inflight.get(key)
      if (pending) return pending
      // A shared first-page fetch is not bound to one caller's abort signal, so
      // cancelling a background prefetch cannot fail a foreground tab switch.
      const promise = fetchFeed({ view, source }).then((data) => {
        remember(key, data)
        return data
      })
      inflight.set(key, promise)
      const cleanup = () => {
        if (inflight.get(key) === promise) inflight.delete(key)
      }
      promise.then(cleanup, cleanup)
      return promise
    }
    const data = await fetchFeed({ view, source, cursor, signal: context.signal })
    if (!cursor) remember(key, data)
    return data
  })

  orca.panels.handle('models.list', async (_input, context: PanelRequestContext) => {
    const now = Date.now()
    if (modelsCache && now - modelsCache.at < MODELS_CACHE_MS) {
      return modelsCache.catalog
    }
    try {
      const config = await loadModelConfig()
      if (!config.token) {
        throw new Error('缺少 ANTHROPIC_AUTH_TOKEN')
      }
      const catalog = await modelsCatalog(config, context.signal)
      modelsCache = { at: Date.now(), catalog }
      return catalog
    } catch (error) {
      throw new Error(friendlyModelsError(error), { cause: error })
    }
  })

  orca.panels.handle('summary.generate', async ({ item, choice }, context) => {
    try {
      return await summarizeWithLocalModel(
        item,
        choice,
        modelsCache?.catalog.models ?? [],
        context.signal,
      )
    } catch (error) {
      throw new Error(friendlySummaryError(error), { cause: error })
    }
  })

  orca.panels.handle('item.summarize', async ({ item }, context) => {
    const prompt = buildPrompt(item)
    const { agents } = await orca.host.call('agents.list', undefined, {
      signal: context.signal,
    })
    // Prefer an agent that is still working over one that has finished.
    const target =
      agents.find((agent) => agent.terminalId && agent.state !== 'done') ??
      agents.find((agent) => agent.terminalId)
    if (!target || !target.terminalId) {
      return { sent: false, prompt, reason: 'no-agent' }
    }

    const result = await orca.host.call(
      'terminal.sendText',
      {
        terminalId: target.terminalId,
        text: prompt,
        enter: true,
      },
      { signal: context.signal },
    )
    if (!result.accepted) {
      return { sent: false, prompt, reason: 'refused' }
    }
    return {
      sent: true,
      prompt,
      agent: target.agent ?? target.title ?? 'agent',
    }
  })
}
