// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { FeedItemView, FeedViewData, SourceSelection, ViewId } from './vendor/jing-client.mjs'

export interface SummaryModel {
  id: string
  label: string
  /** Reasoning levels the model takes, as the local router reports them. */
  levels: string[]
}

export interface SummaryChoice {
  model: string
  effort: string
  label: string
}

export interface ModelCatalog {
  models: SummaryModel[]
  /** Defaults from ~/.claude/settings.json before the picker overrides them. */
  defaultModel: string
  defaultLabel: string
  defaultEffort: string
}

export interface SummaryResult {
  text: string
  model: string
  label: string
  effort: string
}

declare module 'orca' {
  interface PluginRequests {
    /** One feed page, normalized for the panel. `cursor` asks for the next older page. */
    'feed.get': {
      input: {
        view: ViewId
        source: SourceSelection
        refresh?: boolean
        cursor?: string
      }
      output: FeedViewData
    }
    /** The local router's models and each one's reasoning levels. */
    'models.list': {
      input: Record<string, never> | undefined
      output: ModelCatalog
    }
    /** Summarize one item inline with the local model router. */
    'summary.generate': {
      input: { item: FeedItemView; choice?: SummaryChoice | null }
      output: SummaryResult
    }
    /** Fallback: send a summary prompt to a local agent, or return it for manual copying. */
    'item.summarize': {
      input: { item: FeedItemView }
      output: { sent: boolean; prompt: string; agent?: string; reason?: string }
    }
  }
}
