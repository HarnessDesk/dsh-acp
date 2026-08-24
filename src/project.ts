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
  type AcpPlanStatus,
  type AcpToolKind,
  type AcpUpdate,
  type AcpUsage,
  type DshEvent,
} from './types.ts'

/**
 * Tool names to ACP's presentation kinds. The names are the harness's own
 * tool ids; anything unrecognised is `other`, which renders as a plain card
 * rather than guessing wrong about what a tool did.
 */
const TOOL_KINDS: Readonly<Record<string, AcpToolKind>> = {
  bash: 'execute',
  read: 'read',
  write: 'edit',
  edit: 'edit',
  multi_edit: 'edit',
  glob: 'search',
  grep: 'search',
  web_search: 'fetch',
  web_fetch: 'fetch',
  skill: 'think',
  todo_write: 'think',
  subagent: 'think',
  subagent_fork: 'think',
  workflow: 'think',
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
  switch (name) {
    case 'bash':
      return first('command') ?? name
    case 'read':
    case 'write':
    case 'edit':
    case 'multi_edit':
      return first('file_path', 'path') ?? name
    case 'glob':
    case 'grep':
      return first('pattern', 'query') ?? name
    case 'skill':
      return first('name') ?? name
    case 'web_search':
    case 'web_fetch':
      return first('query', 'url') ?? name
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

  constructor(options: { readonly replay?: boolean } = {}) {
    this.#replay = options.replay ?? false
  }

  #title: string | undefined
  #contextWindow: number | undefined
  #lastContextUse = 0
  #sawUsage = false
  readonly #turn = { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0 }
  readonly #toolNames = new Map<string, string>()

  /** The name the harness gave this conversation, once it has named one. */
  get title(): string | undefined {
    return this.#title
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

  #onRequestContext(data: Record<string, unknown>): AcpUpdate[] {
    const size = asNumber(data['contextWindow'])
    if (size > 0) this.#contextWindow = size
    // A window that arrives after the first usage completes a fraction we
    // could not send at the time.
    return this.#sawUsage ? this.#usageUpdate() : []
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
    if (size === undefined || this.#lastContextUse <= 0) return []
    return [{ sessionUpdate: 'usage_update', used: this.#lastContextUse, size }]
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
    if (!this.#replay) return []
    const message = isRecord(data['message']) ? data['message'] : data
    const source = isRecord(message['source']) ? message['source'] : {}
    // Tool results are user-role messages in the harness's model; they are
    // already rendered as tool cards and must not appear twice.
    if (source['kind'] !== 'user') return []
    const text = resultTextOf(message['content'])
    return text.length > 0
      ? [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }]
      : []
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
    this.#turn.input = 0
    this.#turn.output = 0
    this.#turn.cachedRead = 0
    this.#turn.cachedWrite = 0
    this.#turn.thought = 0
    this.#sawUsage = false
  }
}
