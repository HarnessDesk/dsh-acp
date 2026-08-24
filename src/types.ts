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

/**
 * DeepSeek Harness's own token-meter projections, declared structurally like
 * everything else in this module.
 *
 * `@deepseek-ai/dsh-token-meter` registers three units with
 * `ctx.sessionProjections`, and two of them are what a context indicator is
 * actually made of. They are read rather than recomputed for the same reason
 * the rest of this adapter reads rather than recomputes: the harness knows
 * things about its own prompt that no observer of the event stream does —
 * chiefly that a compaction shrank the conversation, which reports no usage
 * of its own and so cannot be seen in `assistant/chunk` at all.
 */

/**
 * `contextPressure` — occupancy, anchored to provider-reported usage.
 *
 * The harness's own doc is explicit that the fields are not one atomic
 * observation: each is a last-wins record of a different moment, so a model
 * switch can pair a fresh capacity with the previous route's pressure until
 * the next request reports usage. That is acceptable for a status display and
 * would not be for billing; this adapter only ever draws a ring with it.
 */
export interface DshContextPressure {
  /** Provider-reported prompt size of the most recent request; output excluded. */
  readonly pressureTokens?: number
  /** That sample, repriced for everything the surface gained or lost since. */
  readonly projectedTokens?: number
  /** Newest recorded route capacity. */
  readonly contextWindow?: number
}

/**
 * `contextBreakdown` — what the prompt is *made of*, not what it costs.
 *
 * All three figures come from the meter's fixed density estimate, so they do
 * not sum to the provider-anchored occupancy above and must never be
 * presented as a total. The harness says so itself, and this adapter passes
 * that warning along the wire as `approximate` rather than quietly dropping
 * it — a client that showed these as exact segments of the ring would be
 * making a claim the harness explicitly declined to make.
 */
export interface DshContextBreakdown {
  readonly systemTokens?: number
  readonly toolsTokens?: number
  readonly messageTokens?: number
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
  | {
      readonly sessionUpdate: 'usage_update'
      readonly used: number
      readonly size: number
      readonly _meta?: AcpUpdateMeta
    }

/**
 * One named part of the context, for a client that draws a composition rather
 * than a single bar.
 */
export interface AcpContextSegment {
  readonly id: 'system' | 'tools' | 'messages'
  readonly label: string
  readonly tokens: number
  /** How many things the segment is: the number of tool schemas. Exact. */
  readonly count?: number
}

/**
 * The composition of the context, carried beside the occupancy it explains.
 *
 * `approximate` is load-bearing, not decoration. The segments are priced by
 * the harness's fixed density heuristic while `used` is anchored to what the
 * provider actually charged, so the two are in different units of truth and
 * the segments will not sum to `used`. A client renders this as *shares of a
 * composition*; one that renders it as slices of the ring, or that fills in a
 * "free space" segment by subtraction, is asserting a total nobody measured.
 */
export interface AcpContextBreakdown {
  readonly segments: readonly AcpContextSegment[]
  /** True whenever any segment came from an estimator rather than a provider. */
  readonly approximate: boolean
  /** Who priced it, so a client can name the source in its own interface. */
  readonly source: string
}

/**
 * ACP's extension slot. Nothing here is required to render a session — a
 * client that ignores `_meta` entirely still gets the ring, which is the
 * whole point of putting it here rather than inventing a session update.
 */
export interface AcpUpdateMeta {
  readonly harnessdesk?: {
    readonly contextBreakdown?: AcpContextBreakdown
  }
}

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
