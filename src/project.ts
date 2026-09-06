/**
 * DeepSeek Harness session events, projected onto the ACP vocabulary.
 *
 * This is the whole point of the adapter. The harness ships an ACP server of
 * its own (`@deepseek-ai/dsh-acp`) whose source states its scope plainly:
 * "Emit only committed assistant text. Raw chunks, reasoning, tools, plans,
 * titles, and retry markers are presentation or trace data and stay off the
 * automation wire." That is the right call for a machine client. It is the
 * wrong one for a person watching a conversation, who sees a fifteen-minute
 * run with twenty tool calls arrive as two paragraphs of prose.
 *
 * So this module makes the opposite choice, and keeps it honest by being
 * pure: events in, updates out, no I/O and no harness imports. Every rule
 * below is exercised in `test/project.test.ts` against fixtures captured from
 * a real session log rather than hand-written ones, because the shapes that
 * matter are the ones the harness actually writes.
 *
 * @module
 */

import {
  asNumber,
  asString,
  isRecord,
  type AcpContextBreakdown,
  type AcpContextSegment,
  type AcpPlanStatus,
  type AcpToolKind,
  type AcpUpdate,
  type AcpUsage,
  type DshContextBreakdown,
  type DshContextPressure,
  type DshEvent,
  type DshRoute,
} from './types.ts'

/**
 * Tool names to ACP's presentation kinds. The names are the harness's own
 * tool ids; anything unrecognised is `other`, which renders as a plain card
 * rather than guessing wrong about what a tool did.
 */
const TOOL_KINDS: Readonly<Record<string, AcpToolKind>> = {
  bash: 'execute',
  pwsh: 'execute',
  run_code: 'execute',
  terminal_open: 'execute',
  terminal_send: 'execute',
  terminal_signal: 'execute',
  terminal_close: 'execute',
  terminal_read: 'read',
  terminal_list: 'read',
  read: 'read',
  read_image: 'read',
  write: 'edit',
  edit: 'edit',
  multi_edit: 'edit',
  str_replace_editor: 'edit',
  glob: 'search',
  grep: 'search',
  lsp: 'search',
  session_search: 'search',
  session_event_search: 'search',
  session_event_read: 'search',
  session_event_trace: 'search',
  session_trace: 'search',
  web_search: 'fetch',
  web_fetch: 'fetch',
  skill: 'think',
  todo_write: 'think',
  ask_user_question: 'think',
  exit_plan_mode: 'think',
  subagent: 'think',
  subagent_fork: 'think',
  workflow: 'think',
  send_message: 'think',
  interrupt_agent: 'think',
  list_agents: 'think',
  list_subagent_models: 'think',
  followup_task: 'think',
  spawn_teammate: 'think',
  wait_agent: 'think',
  job_list: 'think',
  job_output: 'think',
  job_kill: 'think',
  create_goal: 'think',
  get_goal: 'think',
  update_goal: 'think',
  ralph: 'think',
  schedule_create: 'think',
  schedule_list: 'think',
  schedule_delete: 'think',
  team_task_create: 'think',
  team_task_get: 'think',
  team_task_list: 'think',
  team_task_update: 'think',
}

/**
 * A one-line label for a tool call. The harness gives us the raw arguments
 * JSON; a card headed `bash` tells the reader nothing, while one headed
 * `wc -l index.html` tells them everything. Each rule below picks the field
 * that carries the intent for that tool, and the fallback is the tool's own
 * name, never a truncated blob of JSON.
 */
export const titleOf = (name: string, args: unknown): string => {
  if (!isRecord(args)) return name
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = asString(args[key])
      if (value !== undefined && value.length > 0) return value
    }
    return undefined
  }
  /** The first line of a longer text, for a card that has one line. */
  const firstLine = (...keys: string[]): string | undefined => {
    const text = first(...keys)
    if (text === undefined) return undefined
    const line = text.split('\n').find((part) => part.trim().length > 0)?.trim()
    return line !== undefined && line.length > 0 ? line : undefined
  }
  /** A string array joined for reading, as `web_search` now sends its queries. */
  const list = (key: string): string | undefined => {
    const value = args[key]
    if (!Array.isArray(value)) return undefined
    const parts = value.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(', ') : undefined
  }
  switch (name) {
    case 'bash':
    case 'pwsh':
      return first('command') ?? name
    case 'run_code':
      return first('description') ?? firstLine('code') ?? name
    case 'read':
    case 'read_image':
    case 'write':
    case 'edit':
    case 'multi_edit':
      return first('file_path', 'path') ?? name
    case 'str_replace_editor': {
      // The editor tool names its verb in `command` — view, create,
      // str_replace, insert — and the file in `path`; both together is the
      // sentence.
      const path = first('path', 'file_path')
      const command = first('command')
      return path === undefined ? command ?? name : command === undefined ? path : `${command} ${path}`
    }
    case 'glob':
    case 'grep':
      return first('pattern', 'query') ?? name
    case 'lsp': {
      const operation = first('operation')
      const file = first('file_path')
      return file === undefined ? operation ?? name : `${operation ?? 'lsp'} ${file}`
    }
    case 'skill':
    case 'spawn_teammate':
      return first('name') ?? name
    case 'web_search':
      return list('queries') ?? first('query') ?? name
    case 'web_fetch':
      return first('url', 'query') ?? name
    case 'terminal_open':
      return first('name', 'cwd') ?? name
    case 'terminal_send':
      return firstLine('text') ?? first('sessionId') ?? name
    case 'terminal_read':
    case 'terminal_close':
    case 'terminal_list':
      return first('sessionId') ?? name
    case 'terminal_signal': {
      const signal = first('signal')
      const session = first('sessionId')
      return signal === undefined ? session ?? name : session === undefined ? signal : `${signal} ${session}`
    }
    case 'send_message':
    case 'followup_task': {
      // The message body is the thing; the recipient names the row when the
      // body is missing, and the tool's own name only when both are.
      const target = first('agent_id', 'target')
      const body = firstLine('message')
      return body ?? (target === undefined ? name : `to ${target}`)
    }
    case 'interrupt_agent':
      return first('agent_id', 'target') ?? name
    case 'list_agents':
      return first('scope') ?? name
    case 'job_output':
    case 'job_kill':
      return first('job_id') ?? name
    case 'ask_user_question': {
      const questions = args['questions']
      const one = Array.isArray(questions) ? questions.find(isRecord) : undefined
      const question = one === undefined ? undefined : asString(one['question'])
      return question !== undefined && question.length > 0 ? question : first('question') ?? name
    }
    case 'exit_plan_mode':
      return firstLine('plan') ?? name
    case 'create_goal':
    case 'ralph':
      return firstLine('objective') ?? name
    case 'update_goal':
      return first('action') ?? first('goal_id') ?? name
    case 'schedule_create':
      return firstLine('prompt') ?? name
    case 'schedule_delete':
      return first('id') ?? name
    case 'session_search':
    case 'session_event_search':
      return first('query') ?? name
    case 'team_task_create':
      return first('subject') ?? name
    case 'team_task_get':
    case 'team_task_update':
      return first('task_id') ?? name
    default:
      return first('description', 'title', 'name') ?? name
  }
}

/** Harness todo statuses are already ACP's three; anything else is pending. */
const planStatusOf = (status: unknown): AcpPlanStatus =>
  status === 'in_progress' || status === 'completed' ? status : 'pending'

const parseArguments = (raw: unknown): unknown => {
  const text = asString(raw)
  if (text === undefined) return raw
  try {
    return JSON.parse(text) as unknown
  } catch {
    // A partial or malformed argument string is normal mid-stream; the raw
    // text is still worth showing, so it is passed through unparsed.
    return text
  }
}

/** Flatten a harness tool result's content blocks into display text. */
const resultTextOf = (content: unknown): string => {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const text = asString(block['text'])
    if (text !== undefined) parts.push(text)
    else if (Array.isArray(block['content'])) parts.push(resultTextOf(block['content']))
  }
  return parts.join('\n')
}

/**
 * One session's running projection.
 *
 * Stateful in three small ways, each because ACP asks for something the
 * harness reports piecemeal: the context window arrives once per request
 * while usage arrives per step, tool names arrive on the call but are needed
 * again on the result, and the per-turn totals are a sum the harness never
 * takes itself.
 */
export class SessionProjection {
  /**
   * Whether to echo the user's own turns back as `user_message_chunk`.
   *
   * Off during a live prompt: the client just sent that text and rendering it
   * again shows the message twice. On during replay, where reconstructing the
   * conversation is the entire point.
   */
  readonly #replay: boolean

  constructor(
    options: {
      readonly replay?: boolean
      /**
       * What an earlier fold of the same log already learned. A live record
       * made for a reopened conversation starts from here, so the list keeps
       * the title and the opening ask the stored row had instead of losing
       * both the moment the conversation is opened.
       */
      readonly seed?: { readonly title?: string; readonly preview?: string }
    } = {},
  ) {
    this.#replay = options.replay ?? false
    this.#title = options.seed?.title
    this.#preview = options.seed?.preview
  }

  #title: string | undefined
  /** The route the log last recorded; see {@link DshRoute}. */
  #route: DshRoute | undefined
  /** How the current turn ended, when it did not simply complete. */
  #turnEnd: { readonly kind: 'error'; readonly message: string } | { readonly kind: 'max-tokens' } | undefined
  #contextWindow: number | undefined
  #lastContextUse = 0
  #sawUsage = false
  /**
   * Occupancy as the harness's own token meter reports it, when the
   * composition mounts one. It supersedes `#lastContextUse` rather than
   * averaging with it — see `#fill`.
   */
  #meteredUse: number | undefined
  /** The composition of the prompt, from the meter's breakdown projection. */
  #breakdown: DshContextBreakdown | undefined
  /** How many tool schemas the newest request envelope carried. Exact. */
  #toolCount: number | undefined
  readonly #turn = { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0 }
  readonly #toolNames = new Map<string, string>()

  /** The name the harness gave this conversation, once it has named one. */
  #preview: string | undefined

  /** The opening ask, for a listed conversation the harness never titled. */
  get preview(): string | undefined {
    return this.#preview
  }

  get title(): string | undefined {
    return this.#title
  }

  /**
   * The provider, model and effort the conversation was last running on, in
   * log order: a `model/selection` chosen for the next request, else the last
   * request's own header. Undefined until the log has said.
   */
  get route(): DshRoute | undefined {
    return this.#route
  }

  /** The context window the current route reports, once `request/context` has landed. */
  get contextWindow(): number | undefined {
    return this.#contextWindow
  }

  /**
   * Project one harness event. Returns every ACP update it implies — usually
   * zero or one, occasionally two when a usage chunk both accumulates totals
   * and completes the context fraction.
   */
  onEvent(event: DshEvent): AcpUpdate[] {
    const data = isRecord(event.data) ? event.data : {}
    switch (event.type) {
      case 'request/header':
        return this.#onRequestHeader(data)
      case 'request/context':
        return this.#onRequestContext(data)
      case 'assistant/chunk':
        return this.#onChunk(data)
      case 'tool/call':
        return this.#onToolCall(data)
      case 'tool/result':
        return this.#onToolResult(data)
      case 'todo/write':
        return this.#onTodoWrite(data)
      case 'user/message':
        return this.#onUserMessage(data)
      case 'model/selection':
        // A choice for the *next* request, written by a client that switched
        // the route mid-conversation. Later in the log than the header of the
        // request it applies to has not yet been assembled, so it wins.
        this.#readRoute(data)
        return []
      case 'turn/end':
        this.#onTurnEnd(data)
        return []
      case 'session/title': {
        // ACP has no title update, so this is not projected onto the wire.
        // It is kept because `session/list` rows carry a title, and a client
        // that lists conversations shows "Untitled session" without one while
        // the harness knew exactly what it was.
        const title = asString(data['title'])?.trim()
        if (title !== undefined && title.length > 0) this.#title = title
        return []
      }
      default:
        // Unknown and uninteresting types share this branch on purpose: the
        // harness's vocabulary grows, and an adapter that threw on a new
        // event would break on a harness upgrade it could have survived.
        return []
    }
  }

  /**
   * Remember a route the log names. Effort is kept only when the record
   * carries one: `request/context` names provider and model alone, and a
   * missing effort there must not erase the one the header just recorded.
   */
  #readRoute(record: Record<string, unknown>): void {
    const provider = asString(record['provider'])
    const model = asString(record['model'])
    if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) return
    const effort = asString(record['reasoningEffort'])
    const keptEffort =
      this.#route?.provider === provider && this.#route.model === model ? this.#route.reasoningEffort : undefined
    const reasoningEffort = effort ?? keptEffort
    this.#route = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }

  /**
   * How a turn ended. The harness writes a structured reason: `completed`,
   * `aborted`, `blocked`, `interrupted`, `max-tokens`, or `error` with the
   * provider's own failure. A prompt that returned `end_turn` over an
   * `error` reason told the client the model had answered when it had
   * refused the key — an invalid API key produced a silent empty turn.
   */
  #onTurnEnd(data: Record<string, unknown>): void {
    const reason = data['reason']
    if (!isRecord(reason)) return
    const kind = asString(reason['kind'])
    if (kind === 'error') {
      const error = isRecord(reason['error']) ? reason['error'] : {}
      const code = asString(error['code'])
      const message = asString(error['message']) ?? 'the model request failed'
      this.#turnEnd = { kind: 'error', message: code === undefined ? message : `${message} (${code})` }
    } else if (kind === 'max-tokens') {
      this.#turnEnd = { kind: 'max-tokens' }
    }
  }

  /** The turn's ending, when it was not a plain completion; cleared by `endTurn`. */
  get turnEnd(): { readonly kind: 'error'; readonly message: string } | { readonly kind: 'max-tokens' } | undefined {
    return this.#turnEnd
  }

  #onRequestContext(data: Record<string, unknown>): AcpUpdate[] {
    this.#readRoute(data)
    const size = asNumber(data['contextWindow'])
    if (size > 0) this.#contextWindow = size
    // A window that arrives after the first usage completes a fraction we
    // could not send at the time. The meter can supply that numerator too, so
    // the test is the fill itself rather than "did a usage chunk arrive".
    return this.#fill > 0 ? this.#usageUpdate() : []
  }

  /**
   * The assembled request envelope: the system prompt and the tool schemas
   * the harness is about to send.
   *
   * Only the tool *count* is taken from it. The envelope carries the full
   * text of both, and pricing them here would mean shipping a tokenizer and
   * guessing at DeepSeek's — while the harness already prices them, with the
   * same estimator it prices everything else with, and publishes the result
   * as the `contextBreakdown` projection. A count is different: it is exact,
   * it needs nothing, and "23 tool schemas" is the part of that row a reader
   * can act on.
   */
  #onRequestHeader(data: Record<string, unknown>): AcpUpdate[] {
    const header = isRecord(data['header']) ? data['header'] : undefined
    // The call config is the one record that carries the whole route, effort
    // included; it is what a reopened conversation resumes on.
    if (header !== undefined && isRecord(header['config'])) this.#readRoute(header['config'])
    const tools = header?.['tools']
    if (!Array.isArray(tools)) return []
    if (tools.length === this.#toolCount) return []
    this.#toolCount = tools.length
    // The count only changes what an existing breakdown row *says*, so it is
    // worth re-sending only when there is a breakdown to re-send.
    return this.#breakdown === undefined ? [] : this.#usageUpdate()
  }

  /**
   * One value from the harness's session-projection registry.
   *
   * Kept here, in the pure mapper, rather than in the plugin: which
   * projections matter and what they mean for the wire is mapping, and the
   * plugin's job is only to hand them over. Unknown keys are ignored for the
   * same reason unknown events are.
   *
   * @param key - the projection key, as `SessionProjectionMap` names it.
   * @param value - the unit's whole current value.
   * @returns the ACP updates the new value implies.
   */
  onProjection(key: string, value: unknown): AcpUpdate[] {
    if (!isRecord(value)) return []
    switch (key) {
      case 'contextPressure':
        return this.#onPressure(value as DshContextPressure)
      case 'contextBreakdown':
        return this.#onBreakdown(value as DshContextBreakdown)
      default:
        return []
    }
  }

  #onPressure(value: DshContextPressure): AcpUpdate[] {
    const size = asNumber(value.contextWindow)
    if (size > 0) this.#contextWindow = size
    // `projectedTokens` before `pressureTokens`: the first is what the *next*
    // request would cost, which is the question a context indicator is asked,
    // and it is the only one of the two that moves when a compaction shadows
    // a span — compaction reports no usage, so an occupancy built from usage
    // alone stays stale until the next request happens to run.
    const used = asNumber(value.projectedTokens) || asNumber(value.pressureTokens)
    if (used <= 0) return []
    this.#meteredUse = used
    return this.#usageUpdate()
  }

  #onBreakdown(value: DshContextBreakdown): AcpUpdate[] {
    const next = {
      systemTokens: asNumber(value.systemTokens),
      toolsTokens: asNumber(value.toolsTokens),
      messageTokens: asNumber(value.messageTokens),
    }
    if (next.systemTokens + next.toolsTokens + next.messageTokens <= 0) return []
    this.#breakdown = next
    return this.#usageUpdate()
  }

  /**
   * The composition, as the wire carries it. Empty segments are dropped: a
   * session before its first request has no tool schemas, and a zero-token
   * row invites a reader to conclude something was measured at zero.
   */
  #contextBreakdown(): AcpContextBreakdown | undefined {
    const source = this.#breakdown
    if (source === undefined) return undefined
    const segments: AcpContextSegment[] = []
    const push = (id: AcpContextSegment['id'], label: string, tokens: number, count?: number): void => {
      if (tokens > 0) segments.push({ id, label, tokens, ...(count === undefined ? {} : { count }) })
    }
    push('system', 'System prompt', asNumber(source.systemTokens))
    push('tools', 'Tool schemas', asNumber(source.toolsTokens), this.#toolCount)
    push('messages', 'Messages', asNumber(source.messageTokens))
    if (segments.length === 0) return undefined
    return {
      segments,
      // Every segment is the meter's fixed density estimate. Nothing here is
      // provider-anchored, and the flag says so on every send rather than
      // being something a client has to know about DeepSeek Harness.
      approximate: true,
      source: 'DeepSeek Harness token meter',
    }
  }

  /**
   * Occupancy, from the best source that has spoken.
   *
   * The meter wins when it is mounted, because it sees what the event stream
   * does not: compaction, and the surface as it stands rather than as the
   * last request found it. Without it — a composition with no `token-meter`
   * plugin — the per-request sum below is still a true fraction, and a ring
   * drawn from it is better than no ring.
   */
  get #fill(): number {
    return this.#meteredUse ?? this.#lastContextUse
  }

  #onChunk(data: Record<string, unknown>): AcpUpdate[] {
    const chunk = data['chunk']
    if (!isRecord(chunk)) return []
    switch (chunk['type']) {
      case 'text-delta': {
        const text = asString(chunk['text']) ?? ''
        return text.length > 0
          ? [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }]
          : []
      }
      case 'reasoning-delta': {
        const text = asString(chunk['text']) ?? ''
        return text.length > 0
          ? [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }]
          : []
      }
      case 'block-end': {
        // A completed tool-call block names the call, which the result event
        // does not repeat; remember it so the card keeps its title.
        const block = chunk['block']
        if (isRecord(block) && block['type'] === 'tool-call') {
          const id = asString(block['id'])
          const name = asString(block['name'])
          if (id !== undefined && name !== undefined) this.#toolNames.set(id, name)
        }
        return []
      }
      case 'usage':
        return this.#onUsage(chunk['usage'])
      default:
        return []
    }
  }

  #onUsage(raw: unknown): AcpUpdate[] {
    if (!isRecord(raw)) return []
    const input = asNumber(raw['inputTokens'])
    const output = asNumber(raw['outputTokens'])
    const cachedRead = asNumber(raw['cacheReadTokens'])
    const cachedWrite = asNumber(raw['cacheWriteTokens'])
    const thought = asNumber(raw['reasoningTokens'])

    this.#turn.input += input
    this.#turn.output += output
    this.#turn.cachedRead += cachedRead
    this.#turn.cachedWrite += cachedWrite
    this.#turn.thought += thought
    this.#sawUsage = true

    // Context fill is the *latest* request, not the sum: the harness sends the
    // whole conversation each step, so adding steps would double-count what is
    // one conversation. Cached tokens count — ACP's own session-usage RFD is
    // explicit that they still occupy the window even when they are cheaper.
    // Output counts too: the reply is in context for the next step.
    this.#lastContextUse = input + cachedRead + cachedWrite + output
    return this.#usageUpdate()
  }

  #usageUpdate(): AcpUpdate[] {
    const size = this.#contextWindow
    const used = this.#fill
    if (size === undefined || used <= 0) return []
    const breakdown = this.#contextBreakdown()
    return [{
      sessionUpdate: 'usage_update',
      used,
      size,
      ...(breakdown === undefined ? {} : { _meta: { harnessdesk: { contextBreakdown: breakdown } } }),
    }]
  }

  #onToolCall(data: Record<string, unknown>): AcpUpdate[] {
    const toolCallId = asString(data['callId'])
    if (toolCallId === undefined) return []
    const name = asString(data['name']) ?? this.#toolNames.get(toolCallId) ?? 'tool'
    this.#toolNames.set(toolCallId, name)
    const rawInput = parseArguments(data['arguments'])
    return [{
      sessionUpdate: 'tool_call',
      toolCallId,
      title: titleOf(name, rawInput),
      kind: TOOL_KINDS[name] ?? 'other',
      status: 'in_progress',
      rawInput,
    }]
  }

  #onToolResult(data: Record<string, unknown>): AcpUpdate[] {
    const message = data['message']
    if (!isRecord(message)) return []
    const source = isRecord(message['source']) ? message['source'] : {}
    const blocks = Array.isArray(message['content']) ? message['content'] : []
    const first = blocks.find(isRecord) ?? {}
    const toolCallId =
      asString(source['callId']) ?? asString(first['toolCallId'])
    if (toolCallId === undefined) return []
    const failed = first['isError'] === true
    const text = resultTextOf(first['content'])
    return [{
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: failed ? 'failed' : 'completed',
      ...(text.length > 0
        ? { content: [{ type: 'content' as const, content: { type: 'text' as const, text } }] }
        : {}),
      rawOutput: { output: text, isError: failed },
    }]
  }

  #onTodoWrite(data: Record<string, unknown>): AcpUpdate[] {
    const todos = data['todos']
    if (!Array.isArray(todos)) return []
    const entries = todos.filter(isRecord).map((todo) => ({
      content: asString(todo['content']) ?? '',
      status: planStatusOf(todo['status']),
      priority: 'medium' as const,
    }))
    return entries.length > 0 ? [{ sessionUpdate: 'plan', entries }] : []
  }

  /** Replayed user turns, so a loaded session reads as a conversation. */
  #onUserMessage(data: Record<string, unknown>): AcpUpdate[] {
    const message = isRecord(data['message']) ? data['message'] : data
    const source = isRecord(message['source']) ? message['source'] : {}
    const kind = source['kind']
    // What another agent wrote into this conversation. rc.1 replaced the
    // child's one-way `report` tool with `send_message`: a child's result
    // arrives as a user-role message whose source is `agent-message`, and the
    // runtime's own account of a child settling as `subagent-settled`. Both
    // are what the parent read before it answered — dropping them leaves the
    // parent visibly acting on words nobody was shown — and neither is the
    // person, so they go out marked as a notice, live and on replay alike.
    if (kind === 'agent-message' || kind === 'subagent-settled') {
      const text = resultTextOf(message['content']).trim() || asString(source['summary'])?.trim() || ''
      if (text.length === 0) return []
      const sender = asString(source['senderSessionId'])
      return [{
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: {
          harnessdesk: {
            notice: true,
            from: { kind, ...(sender === undefined ? {} : { senderSessionId: sender }) },
          },
        },
      }]
    }
    // Tool results are user-role messages in the harness's model; they are
    // already rendered as tool cards and must not appear twice.
    if (kind !== 'user') return []
    const text = resultTextOf(message['content'])
    if (text.length === 0) return []
    // Remembered whether or not it is projected: a listed conversation with
    // no title falls back to the opening ask, and that is worth having even
    // when nothing is being replayed onto the wire.
    this.#preview ??= text.trim().slice(0, 200)
    if (!this.#replay) return []
    return [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }]
  }

  /**
   * The turn's totals for `PromptResponse.usage`, or undefined when the
   * harness reported none — an empty usage object would read as a free turn.
   */
  promptUsage(): AcpUsage | undefined {
    if (!this.#sawUsage) return undefined
    const { input, output, cachedRead, cachedWrite, thought } = this.#turn
    // The two sides count differently and the difference is not cosmetic.
    // The harness reports `inputTokens` as the part of the prompt that was
    // *not* served from cache, alongside the cached counts. ACP defines
    // `inputTokens` as the whole input, with `cachedReadTokens` a share of
    // it — which is how a client computes "% cached", and how Codex and
    // Claude Code both report. Passing the harness's number through
    // unchanged makes a 12K-token prompt read as 157 tokens.
    const wholeInput = input + cachedRead + cachedWrite
    return {
      totalTokens: wholeInput + output,
      inputTokens: wholeInput,
      outputTokens: output,
      cachedReadTokens: cachedRead,
      cachedWriteTokens: cachedWrite,
      thoughtTokens: thought,
    }
  }

  /** Forget the per-turn sums; the context fill and window survive the turn. */
  endTurn(): void {
    this.#turnEnd = undefined
    this.#turn.input = 0
    this.#turn.output = 0
    this.#turn.cachedRead = 0
    this.#turn.cachedWrite = 0
    this.#turn.thought = 0
    this.#sawUsage = false
  }
}
