/**
 * The narrow contract this adapter needs from a DeepSeek Harness host tree.
 *
 * Written structurally and resolved at runtime rather than imported, for the
 * reason given in `types.ts`: the harness's packages move on separate version
 * lines, and a plugin that pinned them would break on upgrades it could have
 * survived. The plugin only ever runs *inside* a harness composition, so the
 * packages are present when it matters; what we avoid is a build-time pin.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'

/** A harness session, as much of it as we touch. */
export interface HarnessSession {
  readonly id: string
  readonly header?: { readonly id: string }
}

/** A live agent. */
export interface HarnessAgent {
  readonly id: string
  readonly session: HarnessSession
  followup(message: unknown): void
  whenIdle(): Promise<unknown>
  /**
   * Stop the live turn and clear queued work.
   * `@deepseek-ai/dsh-agent` spells this `cancel(cause, options?)` — the cause
   * is durable, and `{ kind: 'user' }` is the one a person clicking stop
   * means. Optional here only because this contract is structural.
   */
  cancel?(cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }): void
  /** What an older harness tree called the same thing. */
  abort?(): void
}

/**
 * Stop whatever the agent is doing, on behalf of the person who asked.
 *
 * Written as its own function because the two spellings are the whole
 * problem: this adapter called `abort()` alone, the live harness has only
 * `cancel()`, and an optional call to a method that is not there is a silent
 * no-op — which is exactly what a stop button must never be.
 *
 * @returns whether anything was actually asked to stop.
 */
export const stopAgent = (agent: Pick<HarnessAgent, 'cancel' | 'abort'>): boolean => {
  if (typeof agent.cancel === 'function') {
    agent.cancel({ kind: 'user' })
    return true
  }
  if (typeof agent.abort === 'function') {
    agent.abort()
    return true
  }
  return false
}

export interface HarnessAgentHandle {
  readonly agent: HarnessAgent
  dispose(): Promise<void> | void
}

export interface HarnessAgents {
  create(options: {
    sessionId: string
    meta?: Record<string, unknown>
    agentOptions?: Record<string, unknown>
  }): Promise<HarnessAgentHandle>
  /**
   * Put an agent back on a session the store already holds.
   *
   * Optional in the type because a composition without a persistence backend
   * has no session to resume — the adapter checks for the method rather than
   * assuming it, and declares the capability only where both this and the
   * store are present.
   */
  resume?(options: {
    resumeSessionId: string
    meta?: Record<string, unknown>
    agentOptions?: Record<string, unknown>
  }): Promise<HarnessAgentHandle>
  get?(id: string): HarnessAgent | undefined
}

/**
 * The durable session log, as `@deepseek-ai/dsh-session-persistence` exposes
 * it on `ctx.sessionPersistence`.
 *
 * Two calls are all this adapter needs, and both are read-only. `list` gives
 * the conversations that exist; `load` gives one conversation's whole event
 * log — the *same* `SessionEvent` shape the live feed carries, which is what
 * makes replay a fold over `SessionProjection` rather than a second mapper.
 *
 * Typed structurally like everything else here: the harness's packages sit on
 * independent version lines and nothing is imported from them.
 */
export interface HarnessPersistence {
  list(signal?: AbortSignal): Promise<readonly HarnessSessionHeader[]>
  /**
   * The read-model primitive: the stored events from a sequence onward.
   *
   * This is the call replay wants, and `load` is not. The harness documents
   * `readFrom` as "a detached physical suffix read: no preparation cache,
   * torn-tail truncation, synthetic closers, or coordinator-state
   * publication… only events from the valid contiguous stored prefix are
   * returned". `load` prepares a session for *ownership* — it commits cold
   * recovery and rejects a log whose committed prefix does not validate.
   *
   * Measured on this machine: `load` refused **every** stored session with
   * "session event at seq N lacks an identified message", while `readFrom`
   * reads them. Replaying a conversation is reading, not claiming, and using
   * the ownership call for it makes old logs unopenable for no reason.
   */
  readFrom?(id: string, fromSeq: number, signal?: AbortSignal): Promise<{
    readonly meta: HarnessSessionHeader
    readonly events: readonly unknown[]
  }>
  /** The ownership path, kept only as a fallback where `readFrom` is absent. */
  load?(id: string): Promise<{ readonly meta: HarnessSessionHeader; readonly events: readonly unknown[] }>
}

/** What the store knows about a conversation without opening it. */
export interface HarnessSessionHeader {
  readonly id: string
  readonly createdAt?: number
  readonly cwd?: string
  /** Set on a forked session; a fork is not a root conversation. */
  readonly parentSession?: string
  /** `subagent` for a delegated child, which is not a conversation of its own. */
  readonly origin?: string
}

/** The context inside `inject(['sessionPersistence'], …)`. */
export interface HarnessPersistenceContext {
  readonly sessionPersistence: HarnessPersistence
}

/** One approval the harness is asking a client to decide. */
export interface ApprovalRequest {
  readonly agent: HarnessAgent
  readonly callId?: string
  readonly toolName?: string
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/**
 * The cordis context, narrowed. `on` is deliberately loose: cordis events are
 * a registry the host owns, and enumerating them here would be another pin.
 *
 * `inject` is the host's optional-dependency mechanism: the callback runs
 * with a context on which the named services exist, and never runs at all in
 * a composition that does not mount them. It is how an adapter reads a
 * capability it would like without requiring it.
 */
export interface HarnessContext {
  readonly agents: HarnessAgents
  /**
   * The session service, reached through `inject(['sessions'], …)` rather
   * than read off this context — cordis refuses an undeclared service read.
   *
   * One method matters: **`flush` is what puts a conversation on disk.**
   * Disposing an agent handle ends the agent; it does not drain the
   * write-behind buffer. Without it a session's log keeps only the header the
   * store wrote at creation, so the conversation is listed and cannot be
   * opened — which is precisely how this behaved before.
   */
  readonly __sessionsDoc?: never
  readonly logger?: { warn(message: string): void; info?(message: string): void }
  on(event: string, listener: (...args: never[]) => unknown): unknown
  inject(services: readonly string[], apply: (...args: never[]) => unknown): unknown
}

/**
 * The context inside `inject(['sessionProjections'], …)`.
 *
 * `@deepseek-ai/dsh-session-projection` drives every registered unit forward
 * over committed session events and notifies this feed with the unit's whole
 * current value — the "whole-value event rule" its own module documentation
 * calls load-bearing, and the reason this adapter never has to reduce a
 * delta itself.
 */
export interface HarnessProjectionContext {
  readonly sessionProjections: {
    onChanged(
      listener: (session: HarnessSession, key: string, value: unknown, seq: number) => void,
    ): () => void
  }
}

/**
 * Build a harness user message.
 *
 * `@deepseek-ai/dsh-llm` owns the shape (it stamps an id and normalises the
 * source), so we use its constructor when the host provides it and fall back
 * to the documented literal only if the import is unavailable — which in a
 * real composition it never is.
 */
/**
 * Whether the harness's own factory could not be reached. Reported once, by
 * the plugin, because a silent fall-through is what hid this for so long.
 */
export let userMessageFallbackReason: string | undefined

/**
 * One user message, in the shape the harness's durable log demands.
 *
 * **The `id` is not optional and its absence is silent.** The harness
 * validates every `user/message`, `assistant/message` and `tool/result` in a
 * session log with `assertMessageEventShape`, which requires a non-empty
 * string `id`, a matching `role`, a `source.kind` and an array `content`. An
 * event that fails it throws `"session event at seq N lacks an identified
 * message"` — and that throw does not surface when the message is written. It
 * surfaces later, when something tries to *read the log back*, by which time
 * the conversation is unreadable and unresumable.
 *
 * This adapter minted the fallback without an id, and the dynamic `import()`
 * that would have used the harness's own factory never resolved — ESM
 * `import()` does not consult `NODE_PATH`, which is exactly how the harness's
 * packages are put on the path for a plugin like this one. So the fallback was
 * not a fallback at all: it was the only path, and every conversation this
 * adapter ever created was rejected by the harness's own validator.
 *
 * The fallback now mints the same id the harness does —
 * `id: MessageId(crypto.randomUUID())` in `@deepseek-ai/dsh-llm`'s
 * `createMessage`, where `MessageId` is a branded-type identity and the value
 * is the plain UUID.
 */
export const createUserMessage = async (text: string): Promise<unknown> => {
  try {
    // The specifier is built at runtime so the compiler does not try to
    // resolve an optional peer that is only present inside a live harness.
    const specifier = ['@deepseek-ai', 'dsh-llm'].join('/')
    const llm = (await import(specifier)) as {
      createUserMessage?: (input: unknown) => unknown
    }
    if (typeof llm.createUserMessage === 'function') {
      return llm.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
    }
    userMessageFallbackReason ??= `@deepseek-ai/dsh-llm resolved but exports no createUserMessage`
  } catch (error) {
    // Recorded rather than swallowed. A host without the package is a test
    // double and perfectly fine — but so is a live harness whose package this
    // resolver cannot see, and those two looked identical until now.
    userMessageFallbackReason ??= error instanceof Error ? error.message : String(error)
  }
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}
