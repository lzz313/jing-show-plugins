import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextView } from "gpui-base";
import {
  checking,
  exec,
  home,
  nextCommand,
  notify,
  readTextFile,
  setShared,
  shared,
  theme,
} from "herdr";
import {
  SOURCE_ORDER,
  SOURCES,
  VIEWS,
  buildPrompt,
  fetchFeed,
  formatClock,
} from "./lib/jing-client.mjs";

const CACHE_KEY = "jing-show.feed";
const MODEL_KEY = "jing-show.model";
const REFRESH_MS = 5 * 60_000;

// latest pages in the background instead of showing a "load more" row: one
// page per this much wheel travel, and as soon as the selection gets near the
// end. Both paths keep roughly a page of buffer ahead of the reader.
const AUTO_LOAD_PX = 600;
const AUTO_LOAD_LINE_PX = 18;
const AUTO_LOAD_TAIL_ITEMS = 5;

// Summary inference goes to the local Anthropic-compatible model router that
// Claude Code already uses (`~/.claude/settings.json`), not to a new agent tab.
const SUMMARY_TIMEOUT_MS = 90_000;
const SUMMARY_MAX_TOKENS = 2000;
const SUMMARY_FALLBACK_MODEL = "auto/deepseek-v4.1-flash";
const SUMMARY_SYSTEM =
  "你是资讯编辑。只输出中文总结正文：3–5 条要点，并说明它为什么值得关注。" +
  "直接列要点，不要复述标题；不要寒暄，不要复述或提及这些指令，不要输出思考过程。";

// Claude Code marks a request that may think adaptively and puts the reasoning
// level in output_config.effort. The local router only reads that level when
// the adaptive thinking marker is there too.
const SUMMARY_THINKING = { type: "adaptive", display: "omitted" };
const EFFORT_LABELS = {
  none: "关闭",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "极致",
};

function effortText(effort) {
  if (!effort) return "默认";
  return `${EFFORT_LABELS[effort] ?? effort} (${effort})`;
}

function normalizeModelId(raw) {
  return String(raw ?? "").replace(/\[[^\]]*\]$/, "");
}

const LOGO_DIR = "mods/jing-show/logos";
const BRAND_LOGO = "mods/jing-show/logo.png";

const SOURCE_LOGOS = {
  x: "x.svg",
  v2ex: "v2ex.png",
  nodeseek: "nodeseek.png",
  linuxdo: "linuxdo.svg",
  hn: "hn.svg",
  github: "github.svg",
  reddit: "reddit.svg",
  "hf-papers": "huggingface.svg",
  simonw: "simonw.png",
  "google-ai": "google.svg",
  producthunt: "producthunt.svg",
};

const SOURCE_INITIALS = {
  x: "X",
  v2ex: "V2",
  nodeseek: "NS",
  linuxdo: "LD",
  hn: "HN",
  github: "GH",
  reddit: "R",
  "hf-papers": "HF",
  simonw: "SW",
  "google-ai": "G",
  producthunt: "PH",
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** Herdr's runtime usually has fetch; curl covers a runtime that blocks it. */
async function herdrFetch(url, init) {
  if (typeof fetch === "function") {
    try {
      return await fetch(url, init);
    } catch {
      // Fall through to curl: a blocked native fetch should not empty the pane.
    }
  }
  const result = await exec(
    "curl",
    ["-fsSL", "--max-time", "15", "-H", "accept: application/json", url],
    { timeout: 20_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `curl ${result.code}`);
  }
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(result.stdout),
  };
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/feed 5\d\d/.test(message)) return "数据暂时不可用，按 r 重试";
  if (/feed 4\d\d/.test(message)) return "请求被拒绝，按 r 重试";
  if (/abort|timeout|timed out/i.test(message)) return "请求超时，按 r 重试";
  return message.length > 80 ? `${message.slice(0, 80)}…` : message || "取数失败";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Local summary model
// ---------------------------------------------------------------------------

let modelConfig = null;

/** Read one of Claude Code's env values, falling back to the process env. */
async function modelEnv(name, env) {
  if (env[name]) return env[name];
  try {
    const result = await exec("printenv", [name], { timeout: 5_000 });
    return result.code === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

/**
 * The local router's fastest/cheapest model. It is the small-fast model Claude
 * Code itself is configured with; the `[1m]` suffix is a Claude Code context
 * marker, not part of the model id the router serves.
 */
async function loadModelConfig() {
  if (modelConfig) return modelConfig;
  let settings = {};
  try {
    const raw = await readTextFile(`${home()}/.claude/settings.json`);
    if (raw) settings = JSON.parse(raw) ?? {};
  } catch {
    // Fall back to printenv when the settings file is missing or unreadable.
  }
  const env = settings.env ?? {};
  const base =
    (await modelEnv("ANTHROPIC_BASE_URL", env)) || "http://127.0.0.1:3425";
  const token = await modelEnv("ANTHROPIC_AUTH_TOKEN", env);
  const rawModel =
    (await modelEnv("ANTHROPIC_SMALL_FAST_MODEL", env)) ||
    (await modelEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", env)) ||
    SUMMARY_FALLBACK_MODEL;
  const model = normalizeModelId(rawModel);
  // Claude Code keeps the effort it starts a session with per model; use it as
  // the default level, and let the picker override it for this pane.
  let effort = "";
  for (const [id, value] of Object.entries(settings.modelSettings ?? {})) {
    if (normalizeModelId(id) !== model) continue;
    if (value?.effortLevel) effort = String(value.effortLevel);
    break;
  }
  // A friendly name before /v1/models has been read.
  const labels = {};
  for (const option of settings.modelPicker?.options ?? []) {
    const id = normalizeModelId(option?.model);
    if (!id || !option?.label) continue;
    labels[id] = String(option.label).split(" · ")[0];
  }
  modelConfig = {
    base: base.replace(/\/+$/, ""),
    token,
    model,
    effort,
    labels,
  };
  return modelConfig;
}

/** GET from the local router; curl covers a runtime that blocks fetch. */
async function localGet(url, headers) {
  if (typeof fetch === "function") {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15_000) : null;
    try {
      return await fetch(url, {
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch {
      // Fall through: localhost fetch can be blocked where curl is not.
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  const args = ["-sS", "--max-time", "15"];
  for (const [name, value] of Object.entries(headers)) {
    args.push("-H", `${name}: ${value}`);
  }
  args.push(url);
  const result = await exec("curl", args, { timeout: 20_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `curl ${result.code}`);
  }
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(result.stdout),
  };
}

/** The models the local router offers, with the reasoning levels each takes. */
async function fetchModelCatalog(config) {
  const response = await localGet(`${config.base}/v1/models`, {
    "anthropic-version": "2023-06-01",
    "x-api-key": config.token,
  });
  if (!response.ok) throw new Error(`models ${response.status}`);
  const data = await response.json();
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .filter((model) => typeof model?.id === "string" && model.id)
    .map((model) => ({
      id: model.id,
      label: model.display_name || model.id,
      levels: Array.isArray(model.reasoning_levels)
        ? model.reasoning_levels
        : (model.supported_reasoning_levels ?? [])
            .map((entry) => entry?.effort)
            .filter(Boolean),
    }));
}

/** POST JSON to the local router; curl covers a runtime that blocks fetch. */
async function localPost(url, body, headers) {
  const payload = JSON.stringify(body);
  const allHeaders = { "content-type": "application/json", ...headers };
  if (typeof fetch === "function") {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
      : null;
    try {
      return await fetch(url, {
        method: "POST",
        headers: allHeaders,
        body: payload,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch {
      // Fall through: localhost fetch can be blocked where curl is not.
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  const args = ["-sS", "--max-time", "90", "-X", "POST"];
  for (const [name, value] of Object.entries(allHeaders)) {
    args.push("-H", `${name}: ${value}`);
  }
  args.push("--data-binary", payload, url);
  const result = await exec("curl", args, { timeout: 95_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `curl ${result.code}`);
  }
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(result.stdout),
  };
}

async function summarizeWithLocalModel(item, choice) {
  const config = await loadModelConfig();
  if (!config.token) {
    throw new Error("没有找到本地模型配置：~/.claude/settings.json 缺少 ANTHROPIC_AUTH_TOKEN");
  }
  const body = {
    model: choice.model,
    max_tokens: SUMMARY_MAX_TOKENS,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: buildPrompt(item) }],
  };
  if (choice.effort) {
    body.thinking = SUMMARY_THINKING;
    body.output_config = { effort: choice.effort };
  }
  const response = await localPost(
    `${config.base}/v1/messages`,
    body,
    {
      "anthropic-version": "2023-06-01",
      "x-api-key": config.token,
    },
  );
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      detail = data?.error?.message || "";
    } catch {
      // Keep the status-based message.
    }
    throw new Error(detail || `summary ${response.status}`);
  }
  const data = await response.json();
  const text = (Array.isArray(data?.content) ? data.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block?.text || "")
    .join("")
    .trim();
  if (!text) {
    if (data?.stop_reason === "max_tokens") {
      throw new Error("回答被截断：级别过高或内容太长，换低一点的级别再试");
    }
    throw new Error("本地模型没有返回内容");
  }
  return {
    text,
    model: choice.model,
    label: choice.label || choice.model,
    effort: choice.effort || "",
  };
}

function friendlySummaryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout|timed out/i.test(message)) {
    return "本地模型响应超时，按 S 重试";
  }
  if (/ECONNREFUSED|connect|fetch failed/i.test(message)) {
    return "连不上本地模型服务，确认 Claude Code 的本地路由已启动";
  }
  if (/402|payment|top.up|allowance/i.test(message)) {
    return "本地模型额度不足，换一个模型或充值后再试";
  }
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

function friendlyModelsError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout|timed out|ECONNREFUSED|connect|fetch failed/i.test(message)) {
    return "读不到模型列表：本地路由没有启动";
  }
  if (/401|403/.test(message)) return "读不到模型列表：本地路由鉴权失败";
  return message.length > 120 ? `${message.slice(0, 120)}…` : message;
}

/** Keep a selection saved in shared state, but ignore a shape we can't use. */
function savedChoice(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.model !== "string" || !value.model) return null;
  return {
    model: value.model,
    effort: typeof value.effort === "string" ? value.effort : "",
    label:
      typeof value.label === "string" && value.label ? value.label : value.model,
  };
}

function contrastOn(hex) {
  const value = /^#([0-9a-f]{6})$/i.exec(hex ?? "")?.[1];
  if (!value) return "#ffffff";
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#ffffff";
}

// ---------------------------------------------------------------------------
// Mod
// ---------------------------------------------------------------------------

export default class JingShow extends View {
  init(_props, cx) {
    this.view = "latest";
    this.source = "all";
    this.items = [];
    this.pageCounts = { all: 0, bySource: {} };
    this.nextCursor = null;
    this.selected = 0;
    this.loading = false;
    this.loadingMore = false;
    this.wheelAcc = 0;
    this.summary = null;
    this.summaryReq = 0;
    this.error = null;
    this.lastUpdated = 0;
    this.dataVersion = 0;
    this.showHelp = false;
    this.sourcesOpen = false;
    this.sourceIndex = 0;
    this.models = null;
    this.modelsLoading = false;
    this.modelsError = null;
    this.modelsOpen = false;
    this.modelStage = "model";
    this.modelIndex = 0;
    this.levelIndex = 0;
    this.modelChoice = savedChoice(shared(MODEL_KEY));
    this.req = 0;
    this.scrollOnLoad = true;
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.modelScroll = ScrollHandle.new();
    this.levelScroll = ScrollHandle.new();
    this.scrollPreview = null;

    this.hydrate();

    // `herdr-app check` runs init for real: render one frame, but do not
    // start a network request, timer or command loop.
    if (checking()) return;

    this.fetch(cx, { quiet: true });
    cx.timer.every(REFRESH_MS, (cx) => this.fetch(cx, { quiet: true }));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") {
          this.handle.focus();
          cx.notify();
        } else if (command === "refresh") {
          this.fetch(cx, { quiet: false });
          cx.notify();
        } else if (command === "summarize") {
          this.summarize(cx);
        } else if (command === "sources") {
          this.toggleSources(cx);
        } else if (command === "model") {
          this.toggleModels(cx);
        } else if (command.startsWith("source:")) {
          this.selectSource(command.slice("source:".length), cx);
        } else if (command === "more") {
          this.loadMore(cx);
        }
      }
    });
  }

  hydrate() {
    const cached = shared(CACHE_KEY);
    if (!cached || typeof cached !== "object") return;
    if (cached.view !== this.view || cached.source !== this.source) return;
    const data = cached.data;
    if (!data || !Array.isArray(data.items)) return;
    this.items = data.items;
    this.pageCounts = data.pageCounts ?? this.pageCounts;
    this.nextCursor = data.nextCursor ?? null;
    this.lastUpdated = data.lastUpdated ?? 0;
    this.dataVersion = data.dataVersion ?? 0;
  }

  requestKey() {
    return `${this.view}:${this.source}`;
  }

  fetch(cx, { quiet = false } = {}) {
    const request = ++this.req;
    this.loading = true;
    this.loadingMore = false;
    this.wheelAcc = 0;
    if (!quiet) {
      this.summary = null;
      this.summaryReq++;
      this.error = null;
    }

    cx.spawn(async (cx) => {
      try {
        const data = await fetchFeed({
          view: this.view,
          source: this.source,
          fetchImpl: herdrFetch,
        });
        if (request !== this.req) return;
        const previous = this.items;
        const selectedId = previous[this.selected]?.id ?? null;
        const unchanged =
          Boolean(previous.length) &&
          this.lastUpdated !== 0 &&
          data.lastUpdated === this.lastUpdated &&
          data.dataVersion === this.dataVersion;

        // A quiet refresh that brought nothing new should not throw away the
        // pages the reader already scrolled through.
        if (quiet && unchanged) {
          this.error = null;
          return;
        }

        if (quiet && previous.length > data.items.length) {
          // New items go on top; the pages already loaded stay below. The
          // existing nextCursor still points past the oldest loaded item.
          const incoming = new Set(data.items.map((item) => item.id));
          this.items = [
            ...data.items,
            ...previous.filter((item) => !incoming.has(item.id)),
          ];
        } else {
          this.items = data.items;
          this.pageCounts = data.pageCounts ?? this.pageCounts;
          this.nextCursor = data.nextCursor ?? null;
        }

        this.lastUpdated = data.lastUpdated;
        this.dataVersion = data.dataVersion;
        const index = selectedId
          ? this.items.findIndex((item) => item.id === selectedId)
          : -1;
        this.selected =
          index >= 0
            ? index
            : clamp(this.selected, 0, Math.max(0, this.items.length - 1));
        this.error = null;
        if (this.scrollOnLoad && this.items.length) {
          this.scroll.scroll_to_item(this.selected);
          this.scrollOnLoad = false;
        }
        setShared(CACHE_KEY, {
          view: data.view,
          source: data.source,
          at: Date.now(),
          data,
        });
      } catch (error) {
        if (request !== this.req) return;
        this.error = friendlyError(error);
        if (!quiet) {
          notify({ title: "jing.show", body: this.error, level: "warning" });
        }
      } finally {
        if (request === this.req) {
          this.loading = false;
          cx.notify();
        }
      }
    });
  }

  // Wheel scrolling has no position to read: ScrollHandle only reveals items.
  // Count the travel instead and fetch another page once it adds up.
  wheel(event, cx) {
    if (this.loading || this.loadingMore || !this.nextCursor) return;
    const lines = event.delta_lines?.y;
    const pixels = event.delta?.y;
    const travel =
      Number.isFinite(lines) && lines !== 0
        ? Math.abs(lines) * AUTO_LOAD_LINE_PX
        : Math.abs(pixels ?? 0);
    if (!travel) return;
    this.wheelAcc += travel;
    if (this.wheelAcc < AUTO_LOAD_PX) return;
    this.wheelAcc = 0;
    this.loadMore(cx);
  }

  maybeAutoLoad(cx) {
    if (this.loading || this.loadingMore || !this.nextCursor) return;
    if (this.selected < this.items.length - AUTO_LOAD_TAIL_ITEMS) return;
    this.wheelAcc = 0;
    this.loadMore(cx);
  }

  loadMore(cx) {
    if (this.loading || this.loadingMore || !this.nextCursor) return;
    const request = this.req;
    this.loadingMore = true;
    this.wheelAcc = 0;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const data = await fetchFeed({
          view: this.view,
          source: this.source,
          cursor: this.nextCursor,
          fetchImpl: herdrFetch,
        });
        if (request !== this.req) return;
        const seen = new Set(this.items.map((item) => item.id));
        this.items = [
          ...this.items,
          ...data.items.filter((item) => !seen.has(item.id)),
        ];
        const page = data.pageCounts ?? { all: 0, bySource: {} };
        const bySource = { ...(this.pageCounts?.bySource ?? {}) };
        for (const [id, count] of Object.entries(page.bySource ?? {})) {
          bySource[id] = (bySource[id] ?? 0) + count;
        }
        this.pageCounts = {
          all: (this.pageCounts?.all ?? 0) + (page.all ?? 0),
          bySource,
        };
        this.nextCursor = data.nextCursor ?? null;
        this.error = null;
      } catch (error) {
        if (request !== this.req) return;
        this.error = friendlyError(error);
      } finally {
        if (request === this.req) {
          this.loadingMore = false;
          cx.notify();
        }
      }
    });
  }

  setView(view, cx) {
    if (this.view === view) return;
    this.view = view;
    this.items = [];
    this.nextCursor = null;
    this.selected = 0;
    this.summary = null;
    this.summaryReq++;
    this.error = null;
    this.scrollOnLoad = true;
    this.fetch(cx);
    cx.notify();
  }

  sourceChoices() {
    return [
      { value: "all", label: "全部来源", count: this.pageCounts?.all ?? 0 },
      ...SOURCE_ORDER.map((id) => ({
        value: id,
        label: SOURCES[id]?.name ?? id,
        count: this.pageCounts?.bySource?.[id] ?? 0,
      })),
    ];
  }

  toggleSources(cx) {
    this.sourcesOpen = !this.sourcesOpen;
    if (this.sourcesOpen) {
      this.modelsOpen = false;
      const ids = ["all", ...SOURCE_ORDER];
      this.sourceIndex = Math.max(0, ids.indexOf(this.source));
    }
    cx.notify();
  }

  moveSource(delta, cx) {
    const size = SOURCE_ORDER.length + 1;
    this.sourceIndex = (this.sourceIndex + delta + size) % size;
    cx.notify();
  }

  selectSource(value, cx) {
    this.sourcesOpen = false;
    if (value !== this.source) {
      this.source = value;
      this.items = [];
      this.nextCursor = null;
      this.selected = 0;
      this.summary = null;
      this.summaryReq++;
      this.error = null;
      this.scrollOnLoad = true;
      this.fetch(cx);
    }
    cx.notify();
  }

  modelMeta(id) {
    return (this.models ?? []).find((model) => model.id === id) ?? null;
  }

  modelLabel(id) {
    return this.modelMeta(id)?.label || modelConfig?.labels?.[id] || id;
  }

  /** A usable selection: the model id, its level when the model takes levels. */
  choiceFor(model, effort) {
    const meta = this.modelMeta(model);
    const levels = meta?.levels ?? [];
    return {
      model,
      effort: effort && levels.includes(effort) ? effort : "",
      label: this.modelLabel(model),
    };
  }

  async resolveChoice() {
    const config = await loadModelConfig();
    let choice = this.modelChoice;
    if (!choice) {
      choice = {
        model: config.model,
        effort: config.effort || "",
        label: this.modelLabel(config.model),
      };
    } else {
      const meta = this.modelMeta(choice.model);
      if (meta) {
        choice = {
          ...choice,
          label: meta.label,
          effort: meta.levels.includes(choice.effort) ? choice.effort : "",
        };
      } else if (!choice.label || choice.label === choice.model) {
        choice = { ...choice, label: this.modelLabel(choice.model) };
      }
    }
    this.modelChoice = choice;
    return choice;
  }

  modelChoices() {
    if (this.models?.length) return this.models;
    if (this.modelChoice) {
      return [
        {
          id: this.modelChoice.model,
          label: this.modelChoice.label,
          levels: [],
        },
      ];
    }
    return [];
  }

  /** Fetch the local router's catalog once; the picker opens immediately. */
  ensureModels(cx) {
    if (this.models?.length || this.modelsLoading) return;
    this.modelsLoading = true;
    this.modelsError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const config = await loadModelConfig();
        if (!config.token) throw new Error("缺少 ANTHROPIC_AUTH_TOKEN");
        const models = await fetchModelCatalog(config);
        this.models = models;
        this.modelsError = models.length ? null : "本地路由没有返回模型";
        this.modelChoice = this.modelChoice
          ? this.choiceFor(this.modelChoice.model, this.modelChoice.effort)
          : this.choiceFor(config.model, config.effort);
        setShared(MODEL_KEY, this.modelChoice);
        const index = models.findIndex(
          (model) => model.id === this.modelChoice.model,
        );
        this.modelIndex = index >= 0 ? index : 0;
        this.modelScroll.scroll_to_item(this.modelIndex);
        if (this.modelStage === "level") {
          const levelIndex = this.levelChoices().indexOf(
            this.modelChoice.effort || "",
          );
          this.levelIndex = levelIndex >= 0 ? levelIndex : 0;
          this.levelScroll.scroll_to_item(this.levelIndex);
        }
      } catch (error) {
        this.modelsError = friendlyModelsError(error);
      } finally {
        this.modelsLoading = false;
        cx.notify();
      }
    });
  }

  toggleModels(cx) {
    this.modelsOpen = !this.modelsOpen;
    if (this.modelsOpen) {
      this.sourcesOpen = false;
      this.showHelp = false;
      this.modelStage = "model";
      const index = this.modelChoices().findIndex(
        (model) => model.id === this.modelChoice?.model,
      );
      this.modelIndex = index >= 0 ? index : 0;
      this.modelScroll.scroll_to_item(this.modelIndex);
      this.ensureModels(cx);
    }
    cx.notify();
  }

  levelChoices() {
    const model = this.modelChoices()[this.modelIndex];
    return ["", ...(model?.levels ?? [])];
  }

  moveModel(delta, cx) {
    const size = this.modelChoices().length;
    if (!size) return;
    this.modelIndex = (this.modelIndex + delta + size) % size;
    this.modelScroll.scroll_to_item(this.modelIndex);
    cx.notify();
  }

  moveLevel(delta, cx) {
    const size = this.levelChoices().length;
    if (!size) return;
    this.levelIndex = (this.levelIndex + delta + size) % size;
    this.levelScroll.scroll_to_item(this.levelIndex);
    cx.notify();
  }

  chooseModel(cx) {
    const model = this.modelChoices()[this.modelIndex];
    if (!model) return;
    if (model.levels.length) {
      this.modelStage = "level";
      const current =
        this.modelChoice?.model === model.id ? this.modelChoice.effort : "";
      const index = this.levelChoices().indexOf(current);
      this.levelIndex = index >= 0 ? index : 0;
      this.levelScroll.scroll_to_item(this.levelIndex);
      cx.notify();
      return;
    }
    this.applyModelChoice(
      {
        model: model.id,
        // A failed catalog leaves no levels to validate against: keep the level
        // already chosen when the row is the current model.
        effort:
          this.modelsError && this.modelChoice?.model === model.id
            ? this.modelChoice.effort
            : "",
        label: model.label,
      },
      cx,
    );
  }

  chooseLevel(cx) {
    const model = this.modelChoices()[this.modelIndex];
    if (!model) return;
    const effort = this.levelChoices()[this.levelIndex] ?? "";
    this.applyModelChoice(
      { model: model.id, effort, label: model.label },
      cx,
    );
  }

  applyModelChoice(choice, cx) {
    this.modelChoice = choice;
    setShared(MODEL_KEY, choice);
    this.modelsOpen = false;
    this.modelStage = "model";
    notify({
      title: "jing.show",
      body: `总结模型：${choice.label} · ${effortText(choice.effort)}`,
      level: "info",
    });
    cx.notify();
  }

  move(delta, cx) {
    if (!this.items.length) return;
    this.selected =
      (this.selected + delta + this.items.length) % this.items.length;
    this.scroll.scroll_to_item(this.selected);
    this.maybeAutoLoad(cx);
    cx.notify();
  }

  selectedItem() {
    return this.items[this.selected] ?? null;
  }

  openSelected(cx) {
    const item = this.selectedItem();
    if (!item) return;
    if (!item.url) {
      notify({ title: "jing.show", body: "这条没有可打开的链接", level: "info" });
      return;
    }
    cx.open_url(item.url);
  }

  copySelected(cx) {
    const item = this.selectedItem();
    if (!item) return;
    const text = item.url || item.title;
    cx.write_to_clipboard(text);
    notify({
      title: "jing.show",
      body: item.url ? "链接已复制" : "标题已复制",
      level: "info",
    });
  }

  summarize(cx) {
    const item = this.selectedItem();
    if (!item) return;
    const request = ++this.summaryReq;
    this.showHelp = false;
    this.modelsOpen = false;
    const choice = this.modelChoice;
    this.summary = {
      itemId: item.id,
      status: "loading",
      text: "",
      model: choice?.model || "",
      label: choice?.label || "本地模型",
      effort: choice?.effort || "",
      error: null,
    };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const chosen = await this.resolveChoice();
        if (request !== this.summaryReq || !this.summary) return;
        this.summary = {
          ...this.summary,
          model: chosen.model,
          label: chosen.label,
          effort: chosen.effort,
        };
        cx.notify();
        const result = await summarizeWithLocalModel(item, chosen);
        if (request !== this.summaryReq || !this.summary) return;
        this.summary = {
          ...this.summary,
          status: "ready",
          text: result.text,
          model: result.model,
          label: result.label,
          effort: result.effort,
          error: null,
        };
      } catch (error) {
        if (request !== this.summaryReq || !this.summary) return;
        this.summary = {
          ...this.summary,
          status: "error",
          text: "",
          error: friendlySummaryError(error),
        };
      } finally {
        if (request === this.summaryReq) cx.notify();
      }
    });
  }

  closeSummary(cx) {
    this.summary = null;
    this.summaryReq++;
    cx.notify();
  }

  key(event, cx) {
    const char = event.key_char ?? event.key;
    const key = event.key;
    const shift = Boolean(event.modifiers?.shift);

    if (this.modelsOpen) {
      if (this.modelStage === "level") {
        if (key === "down" || char === "j") this.moveLevel(1, cx);
        else if (key === "up" || char === "k") this.moveLevel(-1, cx);
        else if (key === "enter") this.chooseLevel(cx);
        else if (key === "escape") {
          this.modelStage = "model";
          this.modelScroll.scroll_to_item(this.modelIndex);
          cx.notify();
        } else if (char === "m") {
          this.modelsOpen = false;
          cx.notify();
        } else return;
      } else {
        if (key === "down" || char === "j") this.moveModel(1, cx);
        else if (key === "up" || char === "k") this.moveModel(-1, cx);
        else if (key === "enter") this.chooseModel(cx);
        else if (key === "escape" || char === "m") {
          this.modelsOpen = false;
          cx.notify();
        } else return;
      }
      cx.stop_propagation();
      return;
    }

    if (this.sourcesOpen) {
      if (key === "down" || char === "j") this.moveSource(1, cx);
      else if (key === "up" || char === "k") this.moveSource(-1, cx);
      else if (key === "enter") {
        const choice = this.sourceChoices()[this.sourceIndex];
        if (choice) this.selectSource(choice.value, cx);
      } else if (key === "escape" || char === "s") {
        this.sourcesOpen = false;
        cx.notify();
      } else return;
      cx.stop_propagation();
      return;
    }

    if (key === "down" || char === "j") this.move(1, cx);
    else if (key === "up" || char === "k") this.move(-1, cx);
    else if (char === "1" || char === "2" || char === "3") {
      this.setView(VIEWS[Number(char) - 1].id, cx);
    } else if (char === "S" || (shift && char === "s")) this.summarize(cx);
    else if (char === "s") this.toggleSources(cx);
    else if (char === "m") this.toggleModels(cx);
    else if (char === "n") this.loadMore(cx);
    else if (char === "r") {
      this.error = null;
      this.fetch(cx);
      cx.notify();
    } else if (key === "enter") this.openSelected(cx);
    else if (char === "y") this.copySelected(cx);
    else if (char === "?") {
      this.showHelp = !this.showHelp;
      cx.notify();
    } else if (key === "escape" && this.summary) {
      this.closeSummary(cx);
    } else if (key === "escape" && this.showHelp) {
      this.showHelp = false;
      cx.notify();
    } else return;
    cx.stop_propagation();
  }

  sourceLabel() {
    if (this.source === "all") return "全部来源";
    return SOURCES[this.source]?.shortName ?? this.source;
  }

  sourceMark(source, size, t) {
    if (source === "all") {
      return image(BRAND_LOGO).size(size).rounded(3).flex_none();
    }
    const logo = SOURCE_LOGOS[source];
    if (logo) {
      return image(`${LOGO_DIR}/${logo}`).size(size).rounded(3).flex_none();
    }
    const meta = SOURCES[source];
    const label =
      SOURCE_INITIALS[source] ?? (meta?.shortName ?? "?").slice(0, 2);
    return h_flex()
      .w(size)
      .h(size)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(3)
      .bg(meta?.color ?? t.dim)
      .text_size(7)
      .font_semibold()
      .text_color(contrastOn(meta?.color))
      .child(label);
  }

  summaryMeta(summary) {
    if (!summary) return "";
    const name = summary.label || summary.model || "本地模型";
    return summary.effort ? `${name} · ${effortText(summary.effort)}` : name;
  }

  summaryBlock(item, t) {
    const summary = this.summary;
    const ready = summary.status === "ready";
    const failed = summary.status === "error";
    return v_flex()
      .id(`jing-summary-${item.id}`)
      .flex_none()
      .mt(4)
      .pt(6)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.5)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(9.5)
              .text_color(t.dim)
              .child(`总结 · ${this.summaryMeta(summary)}`),
          )
          .when(!ready, (el) =>
            el.child(
              div()
                .flex_none()
                .text_size(9.5)
                .text_color(failed ? t.ansi1 : t.dim)
                .child(failed ? "失败" : "正在总结…"),
            ),
          ),
      )
      .when(ready, (el) =>
        el.child(
          TextView.markdown(
            `jing-summary-text-${item.id}`,
            summary.text,
          ).selectable(true),
        ),
      )
      .when(failed, (el) =>
        el.child(
          div()
            .text_size(11)
            .text_color(t.ansi1)
            .child(summary.error),
        ),
      );
  }

  statusLine() {
    if (this.summary) {
      const meta = this.summaryMeta(this.summary);
      if (this.summary.status === "loading") return `正在总结 · ${meta}`;
      if (this.summary.status === "error") return `总结失败 · ${meta}`;
      return `总结 · ${meta}`;
    }
    if (this.error) return this.error;
    if (this.loading && !this.items.length) return "正在加载…";
    const count = `${this.items.length} 条${this.loadingMore ? " · 加载中…" : ""}`;
    if (!this.lastUpdated) return count;
    return `更新于 ${formatClock(this.lastUpdated)} · ${count}`;
  }

  row(item, index, t) {
    const selected = index === this.selected;
    return v_flex()
      .id(`jing-item-${item.id}`)
      .flex_none()
      .px(8)
      .py(6)
      .gap(3)
      .rounded(7)
      .cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((event, cx) => {
        this.selected = index;
        this.handle.focus();
        if (event.click_count === 2) this.openSelected(cx);
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .gap(5)
          .child(this.sourceMark(item.source, 14, t))
          .child(div().text_size(10).text_color(t.muted).child(item.sourceShort))
          .child(div().text_size(10).text_color(t.dim).child(item.timeLabel))
          .child(div().flex_1())
          .when(Boolean(item.metricLabel), (el) =>
            el.child(
              div().text_size(10).text_color(t.dim).child(item.metricLabel),
            ),
          )
          .when(item.isHot, (el) =>
            el.child(
              div()
                .px(4)
                .py(1)
                .rounded(4)
                .bg(t.accent)
                .text_color(t.accent_foreground)
                .text_size(9)
                .child("热"),
            ),
          ),
      )
      .when(Boolean(item.titleOriginal), (el) =>
        el.child(
          div()
            .text_size(12.5)
            .truncate()
            .text_color(t.muted)
            .child(item.titleOriginal),
        ),
      )
      .child(
        div()
          .text_size(12.5)
          .font_semibold()
          .truncate()
          .text_color(t.foreground)
          .child(item.title),
      )
      .when(Boolean(item.summaryOriginal), (el) =>
        el.child(
          div()
            .text_size(12.5)
            .truncate()
            .text_color(t.dim)
            .child(item.summaryOriginal),
        ),
      )
      .when(Boolean(item.summary), (el) =>
        el.child(
          div()
            .text_size(12.5)
            .truncate()
            .text_color(t.muted)
            .child(item.summary),
        ),
      )
      // The summary grows inside the selected row, right under its content.
      .when(this.summary?.itemId === item.id, (el) =>
        el.child(this.summaryBlock(item, t)),
      );
  }

  modelPicker(t) {
    const choices = this.modelChoices();
    const model = choices[this.modelIndex];
    const modelStage = this.modelStage === "model";
    const current = this.modelChoice;
    const rows = modelStage
      ? choices.map((choice, index) => {
          const isCurrent = current?.model === choice.id;
          return h_flex()
            .id(`jing-model-${choice.id}`)
            .items_center()
            .gap(6)
            .px(7)
            .py(3)
            .rounded(6)
            .cursor_pointer()
            .when(isCurrent, (el) => el.bg(t.selected))
            .when(
              !isCurrent && index === this.modelIndex,
              (el) => el.bg(t.hover),
            )
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              this.modelIndex = index;
              this.chooseModel(cx);
            })
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(1)
                .child(
                  div()
                    .truncate()
                    .text_size(11)
                    .text_color(isCurrent ? t.foreground : t.muted)
                    .child(choice.label),
                )
                .child(
                  div()
                    .truncate()
                    .text_size(9)
                    .text_color(t.dim)
                    .child(choice.id),
                ),
            )
            .when(choice.levels.length, (el) =>
              el.child(
                div()
                  .flex_none()
                  .text_size(9)
                  .text_color(t.dim)
                  .child(choice.levels.join(" / ")),
              ),
            )
            .when(isCurrent, (el) =>
              el.child(
                div().flex_none().text_size(10).text_color(t.accent).child("✓"),
              ),
            );
        })
      : this.levelChoices().map((level, index) => {
          const active =
            current?.model === model?.id
              ? current.effort === level
              : level === "";
          return h_flex()
            .id(`jing-level-${level || "default"}`)
            .items_center()
            .gap(6)
            .px(7)
            .py(3)
            .rounded(6)
            .cursor_pointer()
            .when(active, (el) => el.bg(t.selected))
            .when(!active && index === this.levelIndex, (el) => el.bg(t.hover))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              this.levelIndex = index;
              this.chooseLevel(cx);
            })
            .child(
              div()
                .flex_1()
                .text_size(11)
                .text_color(active ? t.foreground : t.muted)
                .child(level ? effortText(level) : "默认（不指定）"),
            )
            .when(active, (el) =>
              el.child(
                div().flex_none().text_size(10).text_color(t.accent).child("✓"),
              ),
            );
        });

    const rowsList = v_flex()
      .id("jing-model-rows")
      .flex_none()
      .h(Math.min(260, Math.max(88, rows.length * 40)))
      .overflow_y_scrollbar()
      .track_scroll(modelStage ? this.modelScroll : this.levelScroll)
      .children(rows);

    return v_flex()
      .id("jing-models")
      .flex_none()
      .px(6)
      .py(4)
      .gap(1)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .px(7)
          .py(3)
          .child(
            modelStage
              ? div().text_size(10).text_color(t.dim).child("总结模型 · 本地路由")
              : h_flex()
                  .items_center()
                  .gap(6)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.modelStage = "model";
                    cx.notify();
                  })
                  .child(
                    div().text_size(10).text_color(t.muted).child("← 返回"),
                  )
                  .child(
                    div()
                      .text_size(10)
                      .text_color(t.dim)
                      .child(`级别 · ${model?.label ?? "模型"}`),
                  ),
          )
          .child(div().flex_1())
          .child(
            div()
              .text_size(9)
              .text_color(t.dim)
              .child(
                modelStage
                  ? "j/k 选择 · Enter 确认 · Esc 关闭"
                  : "j/k 选择 · Enter 确认 · Esc 返回",
              ),
          ),
      )
      .when(this.modelsLoading, (el) =>
        el.child(
          div()
            .px(7)
            .py(3)
            .text_size(10)
            .text_color(t.dim)
            .child("正在读取本地模型…"),
        ),
      )
      .when(Boolean(this.modelsError), (el) =>
        el.child(
          div()
            .px(7)
            .py(3)
            .text_size(10)
            .text_color(t.ansi1)
            .child(this.modelsError),
        ),
      )
      .child(rowsList);
  }

  render(_cx) {
    const t = theme();

    // Ask for the selected row during a render: the handle consumes the request
    // after layout, which a command or key handler alone doesn't guarantee.
    if (this.modelsOpen) {
      const stage = this.modelStage;
      const index = stage === "model" ? this.modelIndex : this.levelIndex;
      const key = `${stage}:${index}`;
      if (this.scrollPreview !== key) {
        this.scrollPreview = key;
        (stage === "model" ? this.modelScroll : this.levelScroll).scroll_to_item(
          index,
        );
      }
    } else {
      this.scrollPreview = null;
    }

    const sourceChip = h_flex()
      .items_center()
      .gap(4)
      .px(6)
      .py(2)
      .rounded(5)
      .bg(this.sourcesOpen ? t.selected : t.raised)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggleSources(cx))
      .child(this.sourceMark(this.source, 13, t))
      .child(
        div().text_size(10).text_color(t.muted).child(this.sourceLabel()),
      )
      .child(
        div()
          .text_size(9)
          .text_color(t.dim)
          .child(this.sourcesOpen ? "▴" : "▾"),
      );

    const refreshButton = div()
      .id("jing-refresh")
      .px(6)
      .py(2)
      .rounded(5)
      .text_size(10)
      .text_color(this.loading ? t.dim : t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        this.error = null;
        this.fetch(cx);
        cx.notify();
      })
      .child(this.loading ? "载入中" : "刷新");

    const header = h_flex()
      .flex_none()
      .px(10)
      .pt(10)
      .pb(7)
      .gap(3)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .children(
        VIEWS.map((entry) =>
          div()
            .id(`jing-view-${entry.id}`)
            .px(7)
            .py(2)
            .rounded(5)
            .text_size(11)
            .cursor_pointer()
            .when(this.view === entry.id, (el) =>
              el.bg(t.selected).text_color(t.foreground),
            )
            .when(this.view !== entry.id, (el) => el.text_color(t.muted))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.setView(entry.id, cx))
            .child(entry.label),
        ),
      )
      .child(div().flex_1())
      .child(sourceChip)
      .child(refreshButton);

    const picker = v_flex()
      .id("jing-sources")
      .flex_none()
      .max_h(320)
      .overflow_y_scrollbar()
      .px(6)
      .py(4)
      .gap(1)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .px(7)
          .py(3)
          .child(div().text_size(10).text_color(t.dim).child("按来源筛选 · 已加载"))
          .child(div().flex_1())
          .child(
            div()
              .text_size(9)
              .text_color(t.dim)
              .child("j/k 选择 · Enter 确认 · Esc 关闭"),
          ),
      )
      .children(
        this.sourceChoices().map((choice, index) =>
          h_flex()
            .id(`jing-source-${choice.value}`)
            .items_center()
            .gap(6)
            .px(7)
            .py(3)
            .rounded(6)
            .cursor_pointer()
            .when(choice.value === this.source, (el) => el.bg(t.selected))
            .when(
              choice.value !== this.source && index === this.sourceIndex,
              (el) => el.bg(t.hover),
            )
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.selectSource(choice.value, cx))
            .child(this.sourceMark(choice.value, 14, t))
            .child(
              div()
                .flex_1()
                .truncate()
                .text_size(11)
                .text_color(choice.value === this.source ? t.foreground : t.muted)
                .child(choice.label),
            )
            .when(choice.count > 0, (el) =>
              el.child(div().text_size(10).text_color(t.dim).child(String(choice.count))),
            )
            .when(choice.value === this.source, (el) =>
              el.child(div().text_size(10).text_color(t.accent).child("✓")),
            ),
        ),
      );

    const list = v_flex()
      .id("jing-list")
      .flex_1()
      .min_h(0)
      .p(6)
      .gap(2)
      .overflow_y_scrollbar()
      .track_scroll(this.scroll)
      .on_scroll_wheel((event, cx) => this.wheel(event, cx))
      .children(this.items.map((item, index) => this.row(item, index, t)))
      .when(!this.items.length, (el) =>
        el.child(
          div()
            .p(12)
            .text_size(11)
            .text_color(t.dim)
            .child(
              this.loading
                ? "正在加载…"
                : this.error
                  ? "数据暂时不可用"
                  : "没有内容；按 s 换来源，或按 r 刷新",
            ),
        ),
      );

    const footer = v_flex()
      .flex_none()
      .px(10)
      .py(6)
      .gap(2)
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(10)
              .text_color(this.error ? t.ansi1 : t.dim)
              .child(this.statusLine()),
          )
          .when(!this.showHelp && !this.error, (el) =>
            el.child(
              div()
                .flex_none()
                .text_size(9.5)
                .text_color(t.dim)
                .child(
                  this.summary
                    ? "Esc 收起 · j/k · m 模型 · Shift+S 再总结"
                    : "j/k · 1/2/3 · s 来源 · m 模型 · r · Enter · Shift+S 总结",
                ),
            ),
          ),
      )
      .when(this.showHelp, (el) =>
        el.child(
          div()
            .text_size(10)
            .text_color(t.muted)
            .child(
              "j/k 移动 · 1/2/3 最新/热点/上升 · s 选来源 · m 选模型/级别 · r 刷新 · Enter 打开 · y 复制链接 · Shift+S 内联总结 · ? 帮助",
            ),
        ),
      );

    return v_flex()
      .id("jing-show-root")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.key(event, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .child(header)
      .when(this.sourcesOpen, (el) => el.child(picker))
      .when(this.modelsOpen, (el) => el.child(this.modelPicker(t)))
      .child(list)
      .child(footer);
  }
}
