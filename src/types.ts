/**
 * The DeepSeek Harness shapes this adapter reads, declared structurally.
 *
 * Nothing here imports `@deepseek-ai/*`. That is deliberate: the harness
 * publishes its packages at several independent version lines (`dsh-session`
 * at `0.0.1-rc.1` while `dsh-agent` is at `0.1.0-rc.6`), and an adapter that
 * pinned them would need a release every time any one of them moved. What we
 * actually depend on is far narrower and far more stable than the packages:
 * the session-event vocabulary, which the harness generates into
 * `KNOWN_SESSION_EVENT_TYPES` and treats as a compatibility surface of its own.
 *
 * So we describe the events we read and validate them at the boundary. An
 * event we do not recognise is ignored rather than fatal — a newer harness
 * may add types, and a bridge that died on an unknown one would be worse than
 * a bridge that renders slightly less.
 *
 * @module
 */

/** One record from the harness's `session/event` firehose. */
export interface DshEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

/** Per-request token counts, as `assistant/chunk`'s `usage` variant carries them. */
export interface DshUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** What the model was routed to, from `request/context`. */
export interface DshRequestContext {
  readonly provider?: string
  readonly model?: string
  readonly contextWindow?: number
}

/** ACP content blocks, narrowed to what this adapter produces. */
export type AcpContent =
  | { readonly type: 'text'; readonly text: string }

/** A tool call's presentation kind, as ACP names them. */
export type AcpToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'

export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type AcpPlanStatus = 'pending' | 'in_progress' | 'completed'

/**
 * The `session/update` payloads this adapter emits. A structural union rather
 * than the SDK's own type so the mapper can be unit-tested without the SDK,
 * and so a client on a different SDK minor still type-checks against it.
 */
export type AcpUpdate =
  | { readonly sessionUpdate: 'agent_message_chunk'; readonly content: AcpContent }
  | { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: AcpContent }
  | { readonly sessionUpdate: 'user_message_chunk'; readonly content: AcpContent }
  | {
      readonly sessionUpdate: 'tool_call'
      readonly toolCallId: string
      readonly title: string
      readonly kind: AcpToolKind
      readonly status: AcpToolStatus
      readonly rawInput?: unknown
    }
  | {
      readonly sessionUpdate: 'tool_call_update'
      readonly toolCallId: string
      readonly status: AcpToolStatus
      readonly content?: readonly { readonly type: 'content'; readonly content: AcpContent }[]
      readonly rawOutput?: unknown
    }
  | {
      readonly sessionUpdate: 'plan'
      readonly entries: readonly {
        readonly content: string
        readonly status: AcpPlanStatus
        readonly priority: 'low' | 'medium' | 'high'
      }[]
    }
  | { readonly sessionUpdate: 'usage_update'; readonly used: number; readonly size: number }

/** The per-turn totals ACP returns on `PromptResponse.usage`. */
export interface AcpUsage {
  readonly totalTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedReadTokens: number
  readonly cachedWriteTokens: number
  readonly thoughtTokens: number
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

export const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0
