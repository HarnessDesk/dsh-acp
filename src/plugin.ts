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
import { createUserMessage, type ApprovalOutcome, type ApprovalRequest, type HarnessAgent, type HarnessContext } from './harness.ts'
import { SessionProjection } from './project.ts'
import { sessionConfigOptions, type AdapterConfig } from './options.ts'
import type { DshEvent } from './types.ts'

/** One ACP session and the harness agent behind it. */
interface Record_ {
  readonly agent: HarnessAgent
  readonly projection: SessionProjection
  dispose(): Promise<void> | void
  inflight?: {
    resolve(reason: string): void
    reject(error: Error): void
  } | undefined
}

const invalidParams = (detail: string): RequestError =>
  RequestError.invalidParams(undefined, detail)

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

  const agent = (connection: AgentSideConnection) => {
    conn = connection
    return {
      initialize: () => Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'harnessdesk-dsh-acp', title: 'DeepSeek Harness', version: '0.1.0' },
        agentCapabilities: {
          // `loadSession` stays false until replay is implemented. Declaring a
          // capability we cannot honour would earn a `session/load` we answer
          // with an error, which is worse for a client than knowing up front.
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
      }),

      authenticate: () => Promise.resolve(),

      newSession: async (params: { cwd?: string }) => {
        if (closed) throw internalError('the adapter has been disposed')
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
          projection: new SessionProjection(),
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

        const message = await createUserMessage(text)
        const stopReason = await new Promise<string>((resolve, reject) => {
          record.inflight = { resolve, reject }
          record.agent.followup(message)
          void record.agent.whenIdle().then(() => {
            if (record.inflight === undefined) return
            record.inflight = undefined
            resolve('end_turn')
          })
        })
        const usage = record.projection.promptUsage()
        record.projection.endTurn()
        return { stopReason, ...(usage !== undefined ? { usage } : {}) }
      },

      cancel: (params: { sessionId: string }) => {
        const record = sessions.get(params.sessionId)
        record?.agent.abort?.()
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
