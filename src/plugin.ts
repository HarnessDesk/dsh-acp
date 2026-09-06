/**
 * The cordis plugin: a full-fidelity ACP server mounted on a DeepSeek Harness
 * host tree.
 *
 * Mount it the way the harness mounts any plugin — as an entry in a
 * composition — and point an ACP client at the process's stdio. Everything
 * the conversation contains reaches the client: streamed text and reasoning,
 * tool calls with their results, plans, permission prompts, and the token
 * accounting that drives a context-usage indicator.
 *
 * @module
 */

import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { createUserMessage, installModelSelection, sandboxModeAvailable, setSandboxMode, stopAgent, userMessageFallbackReason, type ApprovalOutcome, type ApprovalRequest, type HarnessAgent, type HarnessContext, type HarnessPersistence, type HarnessPersistenceContext, type HarnessProjectionContext, type HarnessSession, type HarnessSessionHeader, type ModelSelectionRef } from './harness.ts'
import { SessionProjection } from './project.ts'
import { EFFORTS, sessionConfigOptions, type AdapterConfig, type ControlSupport } from './options.ts'
import type { AcpUpdate, DshEvent } from './types.ts'

/**
 * This adapter's version, as `initialize` reports it.
 *
 * Kept beside the code rather than read from `package.json` at runtime — the
 * published `files` list carries `dist` only, so a runtime read resolves
 * differently once installed. A test pins it to `package.json`, which is what
 * makes a hand-edited constant safe.
 */
export const VERSION = '0.5.2'

/** One ACP session and the harness agent behind it. */
interface Record_ {
  readonly agent: HarnessAgent
  readonly cwd: string
  readonly projection: SessionProjection
  /** The opening ask, so a listed conversation reads as something. */
  preview?: string | undefined
  updatedAt: number
  dispose(): Promise<void> | void
  inflight?: {
    resolve(reason: string): void
    reject(error: Error): void
  } | undefined
  /** Whether the turn in flight was stopped by the person, not by the model. */
  cancelled?: boolean
  /** Updates a `session/load` produced, held until its response is sent. */
  replayed?: readonly AcpUpdate[] | undefined
  /** What the client has chosen for this session, by option id. */
  readonly chosen: Map<string, string>
  /**
   * The live route this session's next step will use, when the harness let us
   * couple one. Mutating `current` is what makes the model picker real.
   */
  selection?: ModelSelectionRef | undefined
  /** Whether a sandbox policy is mounted, so `mode` can actually be switched. */
  modeSupported?: boolean | undefined
}

const invalidParams = (detail: string): RequestError =>
  RequestError.invalidParams(undefined, detail)

/** What one fold over a stored log can say about it without opening it. */
interface StoredDescription {
  title: string | null
  /** Log position of the title event, so two folds can be compared. */
  titleSeq: number | null
  preview: string | null
  /** Epoch ms of the newest event, or null when nothing carried a time. */
  lastActivityAt: number | null
  /**
   * Whether the log could be read at all.
   *
   * Load-bearing, and not the same as "it was empty": a log this harness
   * refuses to parse tells us nothing about what is in it, and a row we could
   * not inspect must be shown rather than hidden on a guess.
   */
  read: boolean
  /**
   * Whether anyone ever spoke in it.
   *
   * Every prompt this adapter sends becomes a `user/message`, so a stored
   * session without one is a session that was opened and abandoned — the
   * harness writes a header and a `sandbox/mode` the moment an agent is
   * composed, whether or not a person ever types. Those are litter, one per
   * app launch, and they filled the list with untitled rows nobody started.
   */
  spoken: boolean
}

/**
 * When a stored event happened, where it says so.
 *
 * The harness's event shapes are not ours and the field has moved between
 * versions, so several spellings are accepted and anything unrecognised is
 * simply absent. A row whose log carries no timestamps falls back to its
 * creation time rather than claiming an activity it cannot evidence.
 */
const timestampOf = (event: unknown): number | undefined => {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as Record<string, unknown>
  for (const key of ['at', 'timestamp', 'time', 'createdAt']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/**
 * Whether a stored event is a person speaking.
 *
 * A tool result is a user-role message in the harness's model, so the source
 * decides rather than the role — counting tool results would make every
 * abandoned session that happened to run a tool look like a conversation.
 */
export const isUserMessage = (event: unknown): boolean => {
  if (typeof event !== 'object' || event === null) return false
  const record = event as Record<string, unknown>
  if (record['type'] !== 'user/message') return false
  const data = record['data']
  const payload = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : record
  const inner = payload['message']
  const message = typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : payload
  const source = message['source']
  const kind = typeof source === 'object' && source !== null
    ? (source as Record<string, unknown>)['kind']
    : undefined
  return kind === 'user'
}

/**
 * Whether a stored header is a conversation someone can reopen.
 *
 * A fork carries a parent and a delegated child is `subagent`; neither is a
 * root conversation, and listing them puts rows in a client's sidebar that
 * nobody started. A header with no `cwd` cannot be resumed at all, because
 * resuming composes an agent in a workspace.
 */
export const isRootConversation = (header: HarnessSessionHeader): boolean =>
  header.parentSession === undefined
  && header.origin !== 'subagent'
  && typeof header.cwd === 'string'
  && header.cwd.length > 0

/**
 * Refuse an MCP tool server offered on `session/new`, rather than taking it
 * and dropping it.
 *
 * The harness does host MCP servers — `@deepseek-ai/dsh-mcp-client` connects
 * to one and registers its tools on `ctx.tools` — but it does so at
 * composition time, one plugin instance per server in `cordis.yml`. Nothing on
 * the ACP wire can add one to a harness that is already composed, and this
 * adapter will not write to somebody's composition on their behalf.
 *
 * So the honest answer is no, and it has to be said out loud. Accepting the
 * parameter and ignoring it — which is what this did until now — is worse than
 * refusing: the client believes its tools reached the model, the model never
 * sees them, and the only symptom is an agent that says it cannot do something
 * it was told it could. A refusal naming `mcpServers` is the one thing a
 * client knows how to handle; it retries without the server and reports why
 * those tools are missing.
 */
export const refuseToolServers = (params: { readonly mcpServers?: unknown }): void => {
  const servers = params.mcpServers
  if (!Array.isArray(servers) || servers.length === 0) return
  throw invalidParams(
    'mcpServers is not supported: DeepSeek Harness loads MCP servers from its ' +
      'composition — one `@deepseek-ai/dsh-mcp-client` entry per server in ' +
      'cordis.yml — and not from a session request, so tools offered this way ' +
      'would never reach the model. Add the server to the composition instead.',
  )
}

const internalError = (detail: string): RequestError =>
  RequestError.internalError(undefined, detail)

export const name = 'harnessdesk-acp'
/** The agent factory is the only service this plugin cannot work without. */
export const inject = ['agents']

/**
 * Mount the server.
 * @param ctx - the harness host tree.
 * @param config - the route and transport this deployment wants.
 */
/**
 * @returns an async disposer. Cordis accepts one from plugin startup and
 *   awaits it while the fiber unloads — see the teardown block at the end for
 *   why an event listener was the wrong mechanism.
 */
export function apply(
  ctx: HarnessContext,
  config: AdapterConfig = {},
): () => Promise<void> {
  const agents = ctx.agents
  const sessions = new Map<string, Record_>()
  let conn: AgentSideConnection | undefined
  let closed = false
  /**
   * The durable store, when this composition has one.
   *
   * `inject` rather than a hard dependency, for the same reason the
   * projections feed is optional: a composition with no persistence backend
   * must keep working, and it does — it simply lists only what is live and
   * declares neither `resume` nor `loadSession`.
   */
  let store: HarnessPersistence | undefined
  ctx.inject(['sessionPersistence'], ((storeCtx: HarnessPersistenceContext) => {
    store = storeCtx.sessionPersistence
  }) as (...args: never[]) => void)
  /**
   * The session service, held for one method: `flush`.
   *
   * Reached through `inject` and not off `ctx` directly — cordis refuses a
   * service read that was never declared ("cannot get property \"sessions\"
   * without inject"), and this adapter must keep working in a composition
   * that has no session service at all.
   */
  let sessionService: { flush?(session: HarnessSession): Promise<void> | void } | undefined
  ctx.inject(['sessions'], ((sessionsCtx: { sessions: { flush?(session: HarnessSession): Promise<void> | void } }) => {
    sessionService = sessionsCtx.sessions
  }) as (...args: never[]) => void)

  const require_ = (sessionId: string): Record_ => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Push an update, never letting a disconnected client fail a live turn. */
  const notify = (sessionId: string, update: unknown): void => {
    void conn?.sessionUpdate({ sessionId, update } as never).catch((error: unknown) => {
      ctx.logger?.warn(`harnessdesk-acp: session/update failed: ${String(error)}`)
    })
  }

  // The firehose. Everything the client sees originates here, which is why the
  // mapping lives in a pure module that can be tested without a harness.
  ctx.on('session/event', ((session: { id?: string; header?: { id: string } }, event: DshEvent) => {
    const sessionId = session.header?.id ?? session.id
    if (sessionId === undefined) return
    const record = sessions.get(sessionId)
    if (record === undefined) return
    for (const update of record.projection.onEvent(event)) notify(sessionId, update)
  }) as (...args: never[]) => void)

  // The harness's own token meter, when the composition mounts one. Its
  // three projections are the only place a client can learn two things the
  // event stream does not carry: that a compaction shrank the conversation,
  // and what the prompt is actually made of.
  //
  // `inject` rather than a hard dependency in `inject = [...]`, deliberately:
  // a composition without `dsh-session-projection` and `dsh-token-meter` must
  // keep working, and it does — the mapper falls back to the per-request sum
  // it has always used, and simply sends no breakdown. This is the same
  // pattern `dsh-token-meter` itself uses to register the units.
  ctx.inject(['sessionProjections'], ((projectionCtx: HarnessProjectionContext) => {
    projectionCtx.sessionProjections.onChanged((session, key, value) => {
      const sessionId = session.header?.id ?? session.id
      if (sessionId === undefined) return
      const record = sessions.get(sessionId)
      if (record === undefined) return
      for (const update of record.projection.onProjection(key, value)) notify(sessionId, update)
    })
  }) as (...args: never[]) => void)

  // Permission prompts are a real interaction, not a policy hook: the client
  // shows them to a person and the answer decides one call.
  ctx.on('approval/request', ((request: ApprovalRequest, next: () => unknown) => {
    const sessionId = request.agent?.session?.id
    const record = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (record === undefined || request.callId === undefined || conn === undefined) return next()
    return conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: request.callId },
      // No "always allow": the harness keeps no per-tool grant (its approval
      // vocabulary is allow once, reject, cancel), so an option that promised
      // one was answered as allow-once and asked again next time. A client
      // that remembers grants — HarnessDesk's own policy layer does — remembers
      // them before this question is ever asked.
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    } as never).then(({ outcome }): ApprovalOutcome => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'reject-once' ? 'rejected' : 'allowed-once'
    })
  }) as (...args: never[]) => unknown)

  /**
   * A stored conversation's title and opening ask, folded from its own log.
   *
   * The harness keeps the title as `session/title` events *inside* the log, and
   * `sessionTitle.get()` wants a live `Session` — so a conversation nobody has
   * opened has no cheap title anywhere. Without this the sidebar reads
   * "Untitled session" for a conversation whose header, once opened, names
   * itself; the pane and the list disagreed about the same conversation.
   *
   * Bounded and cached, because folding a log is not free: only the newest
   * `TITLED_ROWS` rows are read, and a title is remembered for the process's
   * lifetime. Everything else lists without one, which is the honest result of
   * a bounded read rather than a wrong title.
   *
   * The bound has a known edge, and it is a bound rather than a bug: rows are
   * chosen for folding by *creation* time, so a conversation created long ago
   * but used yesterday can fall outside the budget and be ordered by its
   * creation time. Widening `TITLED_ROWS` narrows the window; only folding
   * every log would close it, and that makes listing cost a full read of the
   * whole store.
   */
  /**
   * One fold per stored log, kept against the revision it was computed at.
   *
   * The revision is what makes caching safe. Without it a **negative** verdict
   * is permanent: a session folded while silent, then spoken in, stays marked
   * silent for the life of the process — and since a silent row is hidden,
   * that is a real conversation nobody can see. The same staleness would
   * freeze a title that had not been generated yet.
   *
   * An entry whose revision no longer matches the store's is discarded and
   * re-folded. Where a backend offers no revision at all, nothing negative is
   * cached — see `describeStored`.
   */
  const titleCache = new Map<string, { revision: string | null; described: StoredDescription }>()
  /**
   * How many stored logs one listing will fold.
   *
   * Measured, not guessed: 63 sessions folded in **132ms cold and ~15ms warm**
   * — about 3ms each — and the result is cached for the life of the process,
   * so it is a one-time cost per session. The old budget of 40 was set from
   * caution rather than measurement, and it was too low to be useful: an
   * abandoned session ages out of the window and reappears in the list, and
   * so does an old conversation used recently.
   *
   * A ceiling still exists, because this is linear in the size of the store
   * and a machine with thousands of conversations should not pay seconds on
   * its first listing. Rows past it are listed from their headers alone —
   * shown, never hidden, because a row nothing has inspected is not a row
   * anything can judge.
   */
  const TITLED_ROWS = 400
  // Exposed on the returned disposer's closure only through `__describeStored`
  // below; the rule it encodes — never cache a hiding verdict you cannot prove
  // current — is what `describe-stored.test.ts` pins.
  const describeStored = async (
    persistence: HarnessPersistence,
    sessionId: string,
    /** The store's current revision for this log, when the backend has one. */
    revision: string | null,
  ): Promise<StoredDescription> => {
    const known = titleCache.get(sessionId)
    // Reused only when it can be proved current. A cached entry with no
    // revision is trusted only if the store still offers none — otherwise the
    // backend gained the ability to tell us, and the old entry is unproven.
    if (known !== undefined && known.revision === revision) return known.described
    const found: StoredDescription = {
      title: null,
      titleSeq: null,
      preview: null,
      lastActivityAt: null,
      read: false,
      spoken: false,
    }
    try {
      const stored = await readStored(persistence, sessionId)
      found.read = true
      const projection = new SessionProjection({ replay: true })
      for (const event of stored.events) {
        if (isUserMessage(event)) found.spoken = true
        try {
          projection.onEvent(event as DshEvent)
        } catch {
          // Skipped for projection, but still evidence the conversation was
          // alive at that moment — the timestamp is read below regardless.
        }
        const at = timestampOf(event)
        if (at !== undefined && (found.lastActivityAt === null || at > found.lastActivityAt)) {
          found.lastActivityAt = at
        }
      }
      found.title = projection.title ?? null
      found.titleSeq = projection.titleSeq ?? null
      found.preview = projection.preview ?? null
    } catch {
      // A log this harness refuses is still a row; it simply has no name.
    }
    // A verdict that would *hide* a row is only cached when the store can tell
    // us it has gone stale. Re-folding a silent log costs almost nothing —
    // by definition it holds no conversation — and that is a far better price
    // than a real conversation disappearing.
    if (revision !== null || found.spoken) {
      titleCache.set(sessionId, { revision, described: found })
    }
    return found
  }

  /**
   * One stored conversation's log, read the way a read model should read it.
   *
   * `readFrom(id, 0)` over `load(id)` deliberately — see `HarnessPersistence`.
   * `load` is the ownership path and rejects a log whose committed prefix does
   * not validate, which on this machine was every log written before the
   * harness carried message ids.
   */
  const readStored = async (
    persistence: HarnessPersistence,
    sessionId: string,
  ): Promise<{ readonly meta: HarnessSessionHeader; readonly events: readonly unknown[] }> => {
    const read = typeof persistence.readFrom === 'function'
      ? () => persistence.readFrom!(sessionId, 0)
      : typeof persistence.load === 'function'
        ? () => persistence.load!(sessionId)
        : undefined
    if (read === undefined) {
      throw internalError('this session store offers no way to read a stored conversation')
    }
    try {
      return await read()
    } catch (error) {
      // The harness validates every message event when a log is read back,
      // and reports a failure in its own words: "session event at seq 4 lacks
      // an identified message". That sentence once led this adapter to blame
      // the recording's age. It was not age — it was this adapter writing
      // user messages with no `id`, so *every* conversation it created was
      // unreadable. See `createUserMessage`.
      //
      // A conversation written before that fix stays unreadable, and saying
      // so plainly is the only useful thing left to say about it.
      const detail = error instanceof Error ? error.message : String(error)
      throw internalError(
        `this conversation cannot be read back: the harness refused its stored log (${detail}). Conversations recorded before dsh-acp 0.4.1 are affected and cannot be recovered.`,
      )
    }
  }

  /**
   * Drain this session's write-behind buffer to the store.
   *
   * Disposing the agent handle does not do it. Until this call was here, a
   * conversation's log held only the header written at creation: the store
   * listed it, and opening it found nothing to replay. Failure is logged
   * rather than thrown — a conversation that will not flush is still a
   * conversation the person should be allowed to close.
   */
  const flushSession = async (
    record: Record_,
    options: { rethrow?: boolean } = {},
  ): Promise<void> => {
    const flush = sessionService?.flush
    if (typeof flush !== 'function') return
    try {
      await flush.call(sessionService, record.agent.session)
    } catch (error) {
      ctx.logger?.warn(`harnessdesk-acp: could not flush the session log: ${String(error)}`)
      // An explicit close reports it: the caller asked for this write and is
      // the only one who can decide to retry. A shutdown sweep does not —
      // one unwritable conversation must not stop the others being written.
      if (options.rethrow === true) {
        throw internalError(
          `the conversation could not be written to the session store, so it was left open: ${String(error)}`,
        )
      }
    }
  }

  /**
   * What a session can honour, for the option list it is handed.
   *
   * `mode` is probed once per process — the sandbox policy is a composition
   * fact, not a per-session one — and cached on the record so a list call
   * never waits on a module resolution twice.
   */
  const supportOf = async (record: Record_): Promise<ControlSupport> => {
    record.modeSupported ??= await sandboxModeAvailable()
    return { route: record.selection !== undefined, mode: record.modeSupported }
  }

  /** The route this adapter was configured with, when it names a whole one. */
  const defaultRoute = (
    cfg: AdapterConfig,
  ): { provider: string; model: string } | undefined =>
    cfg.provider !== undefined && cfg.model !== undefined
      ? { provider: cfg.provider, model: cfg.model }
      : undefined

  /**
   * The route a stored session last ran on, where the header records one.
   *
   * A reopened conversation should continue on the model it was having, not
   * on whatever this deployment happens to default to. Read defensively: the
   * header is the harness's shape, not ours, and an absent route simply falls
   * back to the configured one.
   */
  const routeOf = (
    meta: HarnessSessionHeader,
  ): { provider: string; model: string } | undefined => {
    const raw = meta as unknown as { provider?: unknown; model?: unknown }
    return typeof raw.provider === 'string' && typeof raw.model === 'string'
      ? { provider: raw.provider, model: raw.model }
      : undefined
  }

  /** Whether this composition can put an agent back on a stored session. */
  const canResume = (): boolean => store !== undefined && typeof ctx.agents.resume === 'function'

  /**
   * The half `session/load` and `session/resume` share: check the store, put
   * an agent back on the session, and register it.
   *
   * Replay happens *before* the agent is resumed and is held on the record
   * rather than sent here, because the caller decides whether a client asked
   * for history at all.
   */
  const reopen = async (
    params: { sessionId?: string; cwd?: string },
    options: { replay: boolean },
  ): Promise<{ record: Record_; sessionId: string }> => {
    if (closed) throw internalError('the adapter has been disposed')
    const sessionId = params.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw invalidParams('a session id is required')
    }
    const live = sessions.get(sessionId)
    if (live !== undefined) return { record: live, sessionId }
    if (store === undefined || typeof ctx.agents.resume !== 'function') {
      throw invalidParams('this harness keeps no session store, so nothing can be reopened')
    }

    // The stored header decides the workspace, and a client that asked for a
    // different one is refused rather than quietly redirected.
    //
    // `agents.resume` restores the persisted header and ignores the `meta`
    // passed alongside it, so a mismatch does not move the agent — it moves
    // only the client's belief about where its tools are running. A client
    // that asked for project B and got project A's agent would watch edits
    // land in the wrong repository.
    const stored = await readStored(store, sessionId)
    const cwd = stored.meta.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw invalidParams('the stored session names no workspace, so it cannot be reopened')
    }
    if (typeof params.cwd === 'string' && params.cwd.length > 0 && params.cwd !== cwd) {
      throw invalidParams(
        `this conversation belongs to ${cwd}, not ${params.cwd}; reopening it cannot move it`,
      )
    }

    // History is folded through a **throwaway** projection, and the live
    // record gets a fresh one.
    //
    // A replay-mode projection keeps emitting `user_message_chunk` for every
    // user message it sees, which after a load means echoing back the prompt
    // the client has only just sent. It also carries the whole replayed
    // history in its per-turn token accumulator, so the first new
    // `PromptResponse.usage` would bill the conversation twice. Neither state
    // belongs to the live session.
    //
    // The fold runs whether or not the client asked for history, because it
    // is also how this adapter learns three things the stored header does not
    // carry: the route the conversation was running on, its title, and its
    // opening ask. Only the updates are optional.
    const history = new SessionProjection({ replay: true })
    const updates: AcpUpdate[] = []
    for (const event of stored.events) {
      // One bad event is not a lost conversation: the log outlives this
      // adapter's knowledge of it, and an unknown shape is skipped the same
      // way the live feed skips one.
      try {
        updates.push(...history.onEvent(event as DshEvent))
      } catch {
        continue
      }
    }
    const replayed: readonly AcpUpdate[] | undefined = options.replay ? updates : undefined

    // The same coupling a fresh session gets. Without it a reopened
    // conversation advertised model and effort and then refused every choice
    // with "this harness composition fixes the route at startup" — a control
    // that is broken only after being reopened is worse than one that is
    // never offered.
    //
    // The route comes from the log first. The stored header never carried
    // one (rc.1's `SessionHeader` has no provider or model), so until this
    // fold every reopened conversation silently continued on whatever this
    // deployment defaulted to — a conversation had on `deepseek-v4-pro`
    // answered its next question as `deepseek-v4-flash` and said nothing.
    const route = history.route
    const selection: ModelSelectionRef = {
      current: route ?? routeOf(stored.meta) ?? defaultRoute(config),
      assembled: undefined,
    }
    let coupled = false
    // The agent's own options name the folded route too, not only the
    // configured one: a composition that cannot couple a model selection
    // resumes on whatever `agentOptions` said, and saying the config default
    // there put a v4-pro conversation back on flash the moment coupling was
    // unavailable. (Cursor's review of #5.)
    const resumeRoute = selection.current
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      meta: { cwd },
      setup: async (agentCtx) => {
        coupled = await installModelSelection(agentCtx, selection)
      },
      ...(resumeRoute !== undefined
        ? { agentOptions: { provider: resumeRoute.provider, model: resumeRoute.model } }
        : {}),
    })
    // The pickers show what the conversation is actually on, so a person who
    // chose Flash yesterday sees Flash today rather than the deployment's
    // default drawn over an agent answering as Flash. Only a value the picker
    // offers is remembered: an unknown one would draw a choice nobody can
    // re-select.
    const chosen = new Map<string, string>()
    if (coupled && route !== undefined) {
      if ((config.models ?? []).includes(route.model)) chosen.set('model', route.model)
      // Only an effort the log actually names. A conversation that ran on the
      // route's default effort has none recorded, and writing `off` for it
      // would turn thinking off on the next step. (Cursor's review of #5.)
      const efforts = config.efforts ?? EFFORTS
      if (route.reasoningEffort !== undefined && efforts.includes(route.reasoningEffort)) {
        chosen.set('effort', route.reasoningEffort)
      }
    }
    const record: Record_ = {
      agent: handle.agent,
      cwd,
      // Seeded from the fold, so the list row keeps its title and preview
      // across the reopen instead of dropping both for "hello again".
      projection: new SessionProjection({
        seed: {
          ...(history.title === undefined ? {} : { title: history.title }),
          ...(history.titleSeq === undefined ? {} : { titleSeq: history.titleSeq }),
          ...(history.preview === undefined ? {} : { preview: history.preview }),
        },
      }),
      ...(history.preview === undefined ? {} : { preview: history.preview }),
      updatedAt: Date.now(),
      chosen,
      ...(coupled ? { selection } : {}),
      dispose: () => handle.dispose(),
      ...(replayed !== undefined ? { replayed } : {}),
    }
    sessions.set(sessionId, record)
    return { record, sessionId }
  }

  const agent = (connection: AgentSideConnection) => {
    // Said once, out loud. When this adapter cannot reach the harness's own
    // message factory it mints the message itself, which is fine — but it was
    // invisible for long enough to hide a bug that made every conversation
    // unreadable, so it is never invisible again.
    void createUserMessage('').then(() => {
      if (userMessageFallbackReason !== undefined) {
        ctx.logger?.info?.(
          `harnessdesk-acp: using the built-in user-message factory (${userMessageFallbackReason})`,
        )
      }
    })
    conn = connection
    return {
      initialize: () => Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'harnessdesk-dsh-acp', title: 'DeepSeek Harness', version: VERSION },
        agentCapabilities: {
          // Declared from what is actually mounted, never from what this
          // adapter can spell. A composition with no persistence backend has
          // nothing to resume and nothing to replay, and a capability we
          // cannot honour earns a request we answer with an error — worse for
          // a client than knowing up front.
          //
          // `loadSession` and `resume` are different promises and ACP keeps
          // them apart: **load replays the conversation, resume does not.**
          // Both are true here, which is the whole point of this adapter —
          // the harness's own ACP server offers resume alone, so a client that
          // reopens a conversation through it gets a live agent with an empty
          // transcript.
          loadSession: canResume(),
          sessionCapabilities: {
            list: {},
            ...(canResume() ? { resume: {}, close: {} } : {}),
          },
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
      }),

      authenticate: () => Promise.resolve(),

      newSession: async (params: { cwd?: string; mcpServers?: unknown }) => {
        if (closed) throw internalError('the adapter has been disposed')
        refuseToolServers(params)
        const cwd = params.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) {
          throw invalidParams('session/new requires an absolute cwd')
        }
        const sessionId = randomUUID()
        // The selection the picker mutates. Installed during setup, which is
        // the only point at which the harness will accept it — everything
        // registered there exists before the first prompt assembly.
        const selection: ModelSelectionRef = {
          current:
            config.provider !== undefined && config.model !== undefined
              ? { provider: config.provider, model: config.model }
              : undefined,
          assembled: undefined,
        }
        let coupled = false
        const handle = await agents.create({
          sessionId,
          meta: { cwd },
          setup: async (agentCtx) => {
            coupled = await installModelSelection(agentCtx, selection)
          },
          ...(config.provider !== undefined || config.model !== undefined
            ? { agentOptions: { ...(config.provider !== undefined ? { provider: config.provider } : {}), ...(config.model !== undefined ? { model: config.model } : {}) } }
            : {}),
        })
        const record: Record_ = {
          agent: handle.agent,
          cwd,
          projection: new SessionProjection(),
          updatedAt: Date.now(),
          chosen: new Map(),
          ...(coupled ? { selection } : {}),
          dispose: () => handle.dispose(),
        }
        sessions.set(sessionId, record)
        return { sessionId, configOptions: sessionConfigOptions(config, record.chosen, await supportOf(record)) }
      },

      prompt: async (params: { sessionId: string; prompt: readonly unknown[] }) => {
        if (closed) throw internalError('the adapter has been disposed')
        const record = require_(params.sessionId)
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        const text = params.prompt
          .map((block) => (typeof block === 'object' && block !== null && 'text' in block
            ? String((block as { text: unknown }).text) : ''))
          .join('')
        if (text.trim().length === 0) throw invalidParams('empty prompt')

        record.preview ??= text.trim().slice(0, 200)
        record.updatedAt = Date.now()
        record.cancelled = false
        const message = await createUserMessage(text)
        const stopReason = await new Promise<string>((resolve, reject) => {
          record.inflight = { resolve, reject }
          record.agent.followup(message)
          void record.agent.whenIdle().then(() => {
            if (record.inflight === undefined) return
            record.inflight = undefined
            // A stopped turn ends as `cancelled`, which is the answer the
            // client is waiting on: to it, a stop that reports `end_turn`
            // is a turn that finished on its own.
            resolve(record.cancelled === true ? 'cancelled' : 'end_turn')
          })
        })
        const usage = record.projection.promptUsage()
        const ended = record.projection.turnEnd
        record.projection.endTurn()
        // A turn the harness ended on a provider failure is reported as one,
        // not as `end_turn`: the client draws a failed turn with the reason
        // where it drew a finished turn with nothing in it. An invalid key
        // answered "Authentication Fails" into the log and nothing on the
        // wire until this read the reason.
        if (ended?.kind === 'error' && stopReason !== 'cancelled') {
          throw internalError(`the model request failed: ${ended.message}`)
        }
        // A stop the person asked for is reported as one whatever the log
        // says the turn ended on; only an uncancelled turn that ran out of
        // room reads as `max_tokens`. (Codex's review of #5 caught the
        // ordering: the cancelled case was preserved for errors and then
        // overwritten here.)
        const reason = stopReason === 'cancelled' ? 'cancelled' : ended?.kind === 'max-tokens' ? 'max_tokens' : stopReason
        return { stopReason: reason, ...(usage !== undefined ? { usage } : {}) }
      },

      /**
       * Put an agent back on a stored conversation **and replay it**.
       *
       * This is the verb the harness's own ACP server refuses, and refusing it
       * is what makes that server unusable for a person: `session/resume`
       * restores the context but explicitly does not replay history, so a
       * client that reopens a conversation draws an empty transcript over a
       * live agent.
       *
       * Replay is a fold, not a second mapper. The store keeps the same
       * `SessionEvent` log the live feed carries, so the events go through a
       * `SessionProjection` in replay mode and come out as the updates the
       * client would have received the first time.
       */
      loadSession: async (params: { sessionId?: string; cwd?: string; mcpServers?: unknown }) => {
        // Same refusal as `session/new`: a tool server offered here cannot
        // reach a harness that is already composed, and taking it silently is
        // worse than saying no.
        refuseToolServers(params)
        const { record, sessionId } = await reopen(params, { replay: true })
        // Emitted before the response resolves, which is the contract: a
        // client folds these into history rather than drawing them as news.
        for (const update of record.replayed ?? []) notify(sessionId, update)
        record.replayed = undefined
        return { configOptions: sessionConfigOptions(config, record.chosen, await supportOf(record)) }
      },

      /**
       * Put an agent back on a stored conversation without replaying it.
       *
       * The cheaper half of the pair, for a client that keeps its own
       * transcript and wants only the context back.
       */
      resumeSession: async (params: { sessionId?: string; cwd?: string; mcpServers?: unknown }) => {
        refuseToolServers(params)
        const { record, sessionId } = await reopen(params, { replay: false })
        return { sessionId, configOptions: sessionConfigOptions(config, record.chosen, await supportOf(record)) }
      },

      /**
       * Let go of one conversation without ending the process or touching the
       * store — it stays listable and resumable.
       */
      closeSession: async (params: { sessionId?: string }) => {
        const sessionId = params.sessionId
        const record = sessionId === undefined ? undefined : sessions.get(sessionId)
        if (record === undefined) return {}
        // Stop first, then let the turn settle, then flush. Taking the final
        // flush while a turn is still unwinding writes a log that is missing
        // its own last events.
        if (record.inflight !== undefined) {
          stopAgent(record.agent)
          try {
            await record.agent.whenIdle()
          } catch {
            // A cancellation that fails to settle cleanly is still a stop;
            // the flush below is what decides whether anything was lost.
          }
        }
        // **The session survives a failed flush.** Closing is the last chance
        // to write the tail, so a rejection here must not be followed by
        // deleting the record and disposing the handle — that turns "disk
        // full" into a conversation that cannot be retried or recovered. The
        // caller is told, and everything stays where it was.
        await flushSession(record, { rethrow: true })
        sessions.delete(sessionId as string)
        await record.dispose()
        return {}
      },

      /**
       * Every conversation a client could open, newest first.
       *
       * The live ones and the stored ones are one list: a client should not
       * have to know which of its conversations happen to have an agent
       * attached right now. Live wins on a collision, because it knows the
       * title and the preview the store has not been asked for.
       */
      listSessions: async (params: { cwd?: string } = {}) => {
        const rows = new Map<string, {
          sessionId: string
          cwd: string
          title: string | null
          preview: string | null
          updatedAt: string
          sortAt: number
          titleSeq?: number
        }>()
        if (store !== undefined) {
          // Snapshots where the backend has them, because they carry the
          // revision that keeps the fold cache honest; plain headers
          // otherwise, and then nothing that could hide a row is cached.
          let headers: readonly HarnessSessionHeader[] = []
          const revisions = new Map<string, string>()
          try {
            if (typeof store.listSnapshots === 'function') {
              const snapshots = await store.listSnapshots()
              headers = snapshots.map((snapshot) => snapshot.header)
              for (const snapshot of snapshots) {
                if (typeof snapshot.revision === 'string') {
                  revisions.set(snapshot.header.id, snapshot.revision)
                }
              }
            } else {
              headers = await store.list()
            }
          } catch (error) {
            // A store that cannot be read is not a reason to lose the live
            // list; the client gets what this process knows.
            ctx.logger?.warn(`harnessdesk-acp: could not read the session store: ${String(error)}`)
          }
          const stored = headers
            .filter((header) => isRootConversation(header))
            .filter((header) => params.cwd === undefined || header.cwd === params.cwd)
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          const named = await Promise.all(
            stored
              .slice(0, TITLED_ROWS)
              .map((header) => describeStored(store!, header.id, revisions.get(header.id) ?? null)),
          )
          for (const [index, header] of stored.entries()) {
            const describe =
              named[index] ??
              ({ title: null, titleSeq: null, preview: null, lastActivityAt: null, read: false, spoken: false } as StoredDescription)
            // Hidden only when the log was actually read *and* held no user
            // message. A log that could not be parsed, or one past the fold
            // budget, is listed — a row nothing has inspected is not a row
            // anything can judge, and hiding a real conversation is far worse
            // than showing an abandoned one.
            if (describe.read && !describe.spoken) continue
            // ACP's `updatedAt` is last activity, not creation. Sorting and
            // reporting creation time put an old conversation used minutes
            // ago below a newer one nobody has touched since — and told the
            // person it had not been updated since the day it was made. The
            // fold that reads title and preview already walks the log, so the
            // newest event costs nothing extra.
            const at = describe.lastActivityAt ?? header.createdAt ?? 0
            rows.set(header.id, {
              sessionId: header.id,
              cwd: header.cwd as string,
              title: describe.title,
              ...(describe.titleSeq === null ? {} : { titleSeq: describe.titleSeq }),
              preview: describe.preview,
              updatedAt: new Date(at).toISOString(),
              sortAt: at,
            })
          }
        }
        for (const [sessionId, record] of sessions) {
          if (params.cwd !== undefined && record.cwd !== params.cwd) continue
          // The name is whichever fold read it later in the log. The live
          // feed has been seen to miss a `session/title` the titler wrote
          // after the turn — the model-generated name that follows the
          // word-count fallback — while the stored log, being the log, has
          // it; and right after a title event the store may not have
          // flushed it yet while the live feed has. Position in the log
          // decides, never which fold.
          const stored = rows.get(sessionId)
          const storedSeq = stored?.titleSeq ?? -1
          const liveSeq = record.projection.titleSeq ?? -1
          const title =
            stored?.title != null && storedSeq > liveSeq ? stored.title : record.projection.title ?? stored?.title ?? null
          rows.set(sessionId, {
            sessionId,
            cwd: record.cwd,
            title,
            preview: record.preview ?? stored?.preview ?? null,
            updatedAt: new Date(record.updatedAt).toISOString(),
            sortAt: record.updatedAt,
          })
        }
        return {
          sessions: [...rows.values()]
            .sort((a, b) => b.sortAt - a.sortAt)
            .map(({ sortAt: _sortAt, ...row }) => row),
        }
      },

      /**
       * Apply one of the controls `session/new` advertised.
       *
       * Advertising a control and not serving this method is worse than
       * advertising nothing: the client draws a working picker, the person
       * chooses, and the answer is `Method not found`. That is exactly how
       * this behaved until now.
       *
       * Only `mode` reaches the harness today. `model` and `effort` are
       * remembered and returned so the picker keeps the person's choice, but
       * the running agent's route is fixed at composition time — saying so in
       * the response is the honest half of a control this adapter cannot yet
       * honour, and it is tracked rather than silently dropped.
       */
      setSessionConfigOption: async (params: {
        sessionId?: string
        configId?: string
        optionId?: string
        value?: string
      }) => {
        const record = require_(params.sessionId ?? '')
        // ACP's field is `configId` (SessionConfigId). `optionId` is accepted
        // as well because it is the name the option itself carries, and a
        // client that sends the obvious one should not get "unknown option".
        const optionId = params.configId ?? params.optionId ?? ''
        const value = params.value ?? ''
        const option = sessionConfigOptions(config, record.chosen, await supportOf(record)).find(
          (entry) => entry.id === optionId,
        )
        if (option === undefined) throw invalidParams(`unknown option ${JSON.stringify(optionId)}`)
        if (!option.options.some((choice) => choice.value === value)) {
          throw invalidParams(`${optionId} has no choice ${JSON.stringify(value)}`)
        }
        if (optionId === 'mode') {
          const applied = await setSandboxMode(record.agent.session, value)
          if (!applied) {
            throw internalError(
              'this harness composition has no sandbox policy, so its permission mode cannot be changed from here',
            )
          }
        } else if (record.selection === undefined) {
          // Refused rather than remembered. A picker that keeps a choice the
          // agent never adopts is a lie the person cannot see through — this
          // adapter showed "Flash" over an agent answering "I am v4 Pro".
          throw internalError(
            `this harness composition fixes the route at startup, so ${optionId} cannot be changed for a running conversation`,
          )
        } else {
          const provider = record.selection.current?.provider ?? config.provider
          const model = optionId === 'model' ? value : record.selection.current?.model ?? config.model
          if (provider === undefined || model === undefined) {
            throw internalError('this conversation has no provider/model route to change')
          }
          const effort = optionId === 'effort' ? value : record.selection.current?.reasoningEffort
          // Prompt assembly reads this before the next step, so the switch
          // lands on the next step rather than splitting a step in half.
          record.selection.current = {
            provider,
            model,
            ...(effort !== undefined && effort !== 'off' ? { reasoningEffort: effort } : {}),
          }
        }
        record.chosen.set(optionId, value)
        record.updatedAt = Date.now()
        return { configOptions: sessionConfigOptions(config, record.chosen, await supportOf(record)) }
      },

      cancel: (params: { sessionId: string }) => {
        const record = sessions.get(params.sessionId)
        if (record === undefined) return Promise.resolve()
        // The flag is set only when a stop was actually asked for. An agent
        // with neither `cancel` nor `abort` runs to completion, and reporting
        // `cancelled` for a turn that finished normally tells the client its
        // stop worked when the model simply kept going.
        if (stopAgent(record.agent)) {
          record.cancelled = true
        } else {
          ctx.logger?.warn(
            'harnessdesk-acp: this harness agent offers neither cancel() nor abort(); the turn was left running',
          )
        }
        return Promise.resolve()
      },
    }
  }

  const stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  // eslint-disable-next-line no-new -- the connection registers itself on the stream.
  new AgentSideConnection(agent as never, stream as never)

  // Teardown is a **disposer**, not an event listener.
  //
  // Cordis emits no `dispose` event — `ctx.on('dispose', …)` registered an
  // ordinary listener that nothing ever fired, so the shutdown flush this
  // code claimed to perform never ran once. A fiber runs the disposers it
  // was given, in reverse order, and *awaits* them when they are async.
  // Returning one is what makes "quitting must not lose a conversation" true
  // rather than merely written down.
  return async () => {
    closed = true
    // Settled, not fired and forgotten: unloading waits for this, which is
    // the entire point. One conversation that cannot be written must not stop
    // the rest, so failures are logged per session rather than thrown.
    const open = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(
      open.map(async (record) => {
        await flushSession(record)
        await record.dispose()
      }),
    )
  }
}
