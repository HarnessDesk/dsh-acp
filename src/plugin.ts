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
import { createUserMessage, stopAgent, type ApprovalOutcome, type ApprovalRequest, type HarnessAgent, type HarnessContext, type HarnessPersistence, type HarnessPersistenceContext, type HarnessProjectionContext, type HarnessSessionHeader } from './harness.ts'
import { SessionProjection } from './project.ts'
import { sessionConfigOptions, type AdapterConfig } from './options.ts'
import type { AcpUpdate, DshEvent } from './types.ts'

/**
 * This adapter's version, as `initialize` reports it.
 *
 * Kept beside the code rather than read from `package.json` at runtime — the
 * published `files` list carries `dist` only, so a runtime read resolves
 * differently once installed. A test pins it to `package.json`, which is what
 * makes a hand-edited constant safe.
 */
export const VERSION = '0.4.0'

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
}

const invalidParams = (detail: string): RequestError =>
  RequestError.invalidParams(undefined, detail)

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
export function apply(ctx: HarnessContext, config: AdapterConfig = {}): void {
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
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    } as never).then(({ outcome }): ApprovalOutcome => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'reject-once' ? 'rejected' : 'allowed-once'
    })
  }) as (...args: never[]) => unknown)

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
    if (typeof persistence.readFrom === 'function') return persistence.readFrom(sessionId, 0)
    if (typeof persistence.load === 'function') return persistence.load(sessionId)
    throw internalError('this session store offers no way to read a stored conversation')
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

    const projection = new SessionProjection({ replay: options.replay })
    let replayed: readonly AcpUpdate[] | undefined
    let cwd = params.cwd
    if (options.replay) {
      const stored = await readStored(store, sessionId)
      cwd = stored.meta.cwd ?? cwd
      const updates: AcpUpdate[] = []
      for (const event of stored.events) {
        // One bad event is not a lost conversation: the log outlives this
        // adapter's knowledge of it, and an unknown shape is skipped the same
        // way the live feed skips one.
        try {
          updates.push(...projection.onEvent(event as DshEvent))
        } catch {
          continue
        }
      }
      replayed = updates
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw invalidParams('the stored session names no workspace, so it cannot be reopened')
    }

    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      meta: { cwd },
      ...(config.provider !== undefined || config.model !== undefined
        ? { agentOptions: { ...(config.provider !== undefined ? { provider: config.provider } : {}), ...(config.model !== undefined ? { model: config.model } : {}) } }
        : {}),
    })
    const record: Record_ = {
      agent: handle.agent,
      cwd,
      projection,
      updatedAt: Date.now(),
      dispose: () => handle.dispose(),
      ...(replayed !== undefined ? { replayed } : {}),
    }
    sessions.set(sessionId, record)
    return { record, sessionId }
  }

  const agent = (connection: AgentSideConnection) => {
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
        const handle = await agents.create({
          sessionId,
          meta: { cwd },
          ...(config.provider !== undefined || config.model !== undefined
            ? { agentOptions: { ...(config.provider !== undefined ? { provider: config.provider } : {}), ...(config.model !== undefined ? { model: config.model } : {}) } }
            : {}),
        })
        sessions.set(sessionId, {
          agent: handle.agent,
          cwd,
          projection: new SessionProjection(),
          updatedAt: Date.now(),
          dispose: () => handle.dispose(),
        })
        return { sessionId, configOptions: sessionConfigOptions(config) }
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
        record.projection.endTurn()
        return { stopReason, ...(usage !== undefined ? { usage } : {}) }
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
        return { configOptions: sessionConfigOptions(config) }
      },

      /**
       * Put an agent back on a stored conversation without replaying it.
       *
       * The cheaper half of the pair, for a client that keeps its own
       * transcript and wants only the context back.
       */
      resumeSession: async (params: { sessionId?: string; cwd?: string; mcpServers?: unknown }) => {
        refuseToolServers(params)
        const { sessionId } = await reopen(params, { replay: false })
        return { sessionId, configOptions: sessionConfigOptions(config) }
      },

      /**
       * Let go of one conversation without ending the process or touching the
       * store — it stays listable and resumable.
       */
      closeSession: async (params: { sessionId?: string }) => {
        const record = params.sessionId === undefined ? undefined : sessions.get(params.sessionId)
        if (record === undefined) return {}
        if (record.inflight !== undefined) stopAgent(record.agent)
        sessions.delete(params.sessionId as string)
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
        }>()
        if (store !== undefined) {
          let headers: readonly HarnessSessionHeader[] = []
          try {
            headers = await store.list()
          } catch (error) {
            // A store that cannot be read is not a reason to lose the live
            // list; the client gets what this process knows.
            ctx.logger?.warn(`harnessdesk-acp: could not read the session store: ${String(error)}`)
          }
          for (const header of headers) {
            if (!isRootConversation(header)) continue
            if (params.cwd !== undefined && header.cwd !== params.cwd) continue
            const at = header.createdAt ?? 0
            rows.set(header.id, {
              sessionId: header.id,
              cwd: header.cwd as string,
              title: null,
              preview: null,
              updatedAt: new Date(at).toISOString(),
              sortAt: at,
            })
          }
        }
        for (const [sessionId, record] of sessions) {
          if (params.cwd !== undefined && record.cwd !== params.cwd) continue
          rows.set(sessionId, {
            sessionId,
            cwd: record.cwd,
            title: record.projection.title ?? null,
            preview: record.preview ?? null,
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

      cancel: (params: { sessionId: string }) => {
        const record = sessions.get(params.sessionId)
        if (record === undefined) return Promise.resolve()
        record.cancelled = true
        if (!stopAgent(record.agent)) {
          // Better a line in the log than a stop button that reports success
          // and leaves the model running.
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

  ctx.on('dispose', (() => {
    closed = true
    for (const record of sessions.values()) void record.dispose()
    sessions.clear()
  }) as (...args: never[]) => void)
}
