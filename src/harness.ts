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
  get?(id: string): HarnessAgent | undefined
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
  } catch {
    // Fall through: a host without the package is a test double, not a rig.
  }
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}
