/**
 * The mapper, against events captured from a real DeepSeek Harness session
 * log (`test/fixtures/session-events.json`) rather than events invented here.
 * Hand-written fixtures test the author's belief about the shape; recorded
 * ones test the shape.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SessionProjection, titleOf } from '../src/project.ts'
import type { AcpUpdate, DshEvent } from '../src/types.ts'

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/session-events.json', import.meta.url)), 'utf8'),
) as DshEvent[]

/** The harness's own projection values for that same log; see its `_provenance`. */
const projections = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/context-projections.json', import.meta.url)), 'utf8'),
) as {
  contextPressure: { pressureTokens: number; projectedTokens: number; contextWindow: number }
  contextBreakdown: { systemTokens: number; toolsTokens: number; messageTokens: number }
}

const eventsOf = (type: string): DshEvent[] => fixtures.filter((event) => event.type === type)

const project = (events: readonly DshEvent[]): AcpUpdate[] => {
  const projection = new SessionProjection()
  return events.flatMap((event) => projection.onEvent(event))
}

const kinds = (updates: readonly AcpUpdate[]): string[] => updates.map((u) => u.sessionUpdate)

describe('fixtures', () => {
  it('carry the event types the mapper claims to handle', () => {
    const types = new Set(fixtures.map((event) => event.type))
    for (const type of ['request/header', 'request/context', 'assistant/chunk', 'tool/call', 'tool/result', 'todo/write']) {
      expect(types, `fixture set is missing ${type}`).toContain(type)
    }
  })
})

describe('context window and usage', () => {
  it('reads the window off request/context', () => {
    const projection = new SessionProjection()
    for (const event of eventsOf('request/context')) projection.onEvent(event)
    expect(projection.contextWindow).toBe(1_000_000)
  })

  it('says nothing about usage until both halves of the fraction are known', () => {
    const projection = new SessionProjection()
    // Usage before any window: a numerator with no denominator is not a ring.
    const updates = projection.onEvent({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 90 } } },
    })
    expect(updates).toEqual([])
  })

  it('emits the fraction once the window arrives late', () => {
    const projection = new SessionProjection()
    projection.onEvent({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 90 } } },
    })
    const updates = projection.onEvent({ type: 'request/context', data: { contextWindow: 1000 } })
    expect(updates).toEqual([{ sessionUpdate: 'usage_update', used: 100, size: 1000 }])
  })

  it('counts cached and output tokens toward the window, per ACP session-usage', () => {
    const projection = new SessionProjection()
    projection.onEvent({ type: 'request/context', data: { contextWindow: 1000 } })
    const [update] = projection.onEvent({
      type: 'assistant/chunk',
      data: {
        turn: 1, step: 1,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 5, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 25, reasoningTokens: 7 },
        },
      },
    })
    expect(update).toEqual({ sessionUpdate: 'usage_update', used: 100, size: 1000 })
  })

  it('reports context fill as the latest request, not the sum of every step', () => {
    // The harness resends the whole conversation each step. Summing steps
    // would report a session far larger than the model ever saw.
    const projection = new SessionProjection()
    projection.onEvent({ type: 'request/context', data: { contextWindow: 1_000_000 } })
    const usageEvents = eventsOf('assistant/chunk').filter(
      (event) => (event.data as { chunk?: { type?: string } }).chunk?.type === 'usage',
    )
    let last: AcpUpdate | undefined
    for (const event of usageEvents) last = projection.onEvent(event).at(-1) ?? last
    const used = last?.sessionUpdate === 'usage_update' ? last.used : 0
    const biggestSingle = Math.max(
      ...usageEvents.map((event) => {
        const u = (event.data as { chunk: { usage: Record<string, number> } }).chunk.usage
        return (u['inputTokens'] ?? 0) + (u['cacheReadTokens'] ?? 0) + (u['cacheWriteTokens'] ?? 0) + (u['outputTokens'] ?? 0)
      }),
    )
    expect(used).toBe(biggestSingle)
  })

  it('sums the turn for PromptResponse.usage, and reports none when the harness reported none', () => {
    const projection = new SessionProjection()
    expect(projection.promptUsage()).toBeUndefined()
    projection.onEvent({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, reasoningTokens: 2 } } },
    })
    projection.onEvent({
      type: 'assistant/chunk',
      data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 7, reasoningTokens: 5 } } },
    })
    expect(projection.promptUsage()).toEqual({
      totalTokens: 40, inputTokens: 30, outputTokens: 10,
      cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 7,
    })
    // See the convention test below: with no cache in play the two
    // definitions of `inputTokens` coincide, which is why this case alone
    // would not have caught the mismatch.
    projection.endTurn()
    expect(projection.promptUsage()).toBeUndefined()
  })
})

describe('the token meter\'s projections', () => {
  const { contextPressure, contextBreakdown } = projections

  it('takes occupancy from the meter in preference to the per-request sum', () => {
    const projection = new SessionProjection()
    projection.onEvent({ type: 'request/context', data: { contextWindow: 1000 } })
    projection.onEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 90 } } },
    })
    // The meter has seen a compaction the event stream cannot report, so its
    // figure is lower than the last request's. The lower one is the true one.
    const updates = projection.onProjection('contextPressure', { projectedTokens: 60, contextWindow: 1000 })
    expect(updates).toEqual([{ sessionUpdate: 'usage_update', used: 60, size: 1000 }])
  })

  it('prefers the projected figure, which is the one compaction moves', () => {
    const projection = new SessionProjection()
    const [update] = projection.onProjection('contextPressure', {
      pressureTokens: 900,
      projectedTokens: 400,
      contextWindow: 1000,
    })
    expect(update).toEqual({ sessionUpdate: 'usage_update', used: 400, size: 1000 })
  })

  it('learns the window from the meter when no request/context has landed', () => {
    const projection = new SessionProjection()
    projection.onProjection('contextPressure', contextPressure)
    expect(projection.contextWindow).toBe(contextPressure.contextWindow)
  })

  it('carries the composition beside the occupancy it explains', () => {
    const projection = new SessionProjection()
    projection.onProjection('contextPressure', contextPressure)
    const [update] = projection.onProjection('contextBreakdown', contextBreakdown)
    expect(update).toEqual({
      sessionUpdate: 'usage_update',
      used: contextPressure.projectedTokens,
      size: contextPressure.contextWindow,
      _meta: {
        harnessdesk: {
          contextBreakdown: {
            approximate: true,
            source: 'DeepSeek Harness token meter',
            segments: [
              { id: 'system', label: 'System prompt', tokens: contextBreakdown.systemTokens },
              { id: 'tools', label: 'Tool schemas', tokens: contextBreakdown.toolsTokens },
              { id: 'messages', label: 'Messages', tokens: contextBreakdown.messageTokens },
            ],
          },
        },
      },
    })
  })

  it('marks the composition approximate, because the harness does', () => {
    const projection = new SessionProjection()
    projection.onProjection('contextPressure', contextPressure)
    const [update] = projection.onProjection('contextBreakdown', contextBreakdown)
    const meta = update?.sessionUpdate === 'usage_update' ? update._meta : undefined
    const breakdown = meta?.harnessdesk?.contextBreakdown
    expect(breakdown?.approximate).toBe(true)
    // The segments are the meter's density estimate and `used` is anchored to
    // what the provider charged. They are not the same measurement and the
    // wire must not imply that they are, so no total is ever sent.
    expect(breakdown).not.toHaveProperty('totalTokens')
  })

  it('counts the tool schemas exactly, off the request envelope', () => {
    const projection = new SessionProjection()
    projection.onProjection('contextPressure', contextPressure)
    for (const event of eventsOf('request/header')) projection.onEvent(event)
    const [update] = projection.onProjection('contextBreakdown', contextBreakdown)
    const meta = update?.sessionUpdate === 'usage_update' ? update._meta : undefined
    const tools = meta?.harnessdesk?.contextBreakdown?.segments.find((s) => s.id === 'tools')
    const recorded = eventsOf('request/header').at(-1)?.data as { header: { tools: unknown[] } }
    expect(tools?.count).toBe(recorded.header.tools.length)
  })

  it('drops a segment nobody measured rather than reporting it as zero', () => {
    const projection = new SessionProjection()
    projection.onProjection('contextPressure', contextPressure)
    const [update] = projection.onProjection('contextBreakdown', { messageTokens: 120 })
    const meta = update?.sessionUpdate === 'usage_update' ? update._meta : undefined
    expect(meta?.harnessdesk?.contextBreakdown?.segments.map((s) => s.id)).toEqual(['messages'])
  })

  it('ignores projection keys it does not own, and non-values', () => {
    const projection = new SessionProjection()
    expect(projection.onProjection('tokenUsage', { outputTokens: 5 })).toEqual([])
    expect(projection.onProjection('contextPressure', null)).toEqual([])
    expect(projection.onProjection('contextBreakdown', { systemTokens: 0 })).toEqual([])
  })

  it('still draws a ring in a composition with no meter at all', () => {
    const projection = new SessionProjection()
    projection.onEvent({ type: 'request/context', data: { contextWindow: 1000 } })
    const updates = projection.onEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 90 } } },
    })
    expect(updates).toEqual([{ sessionUpdate: 'usage_update', used: 100, size: 1000 }])
  })
})

describe('streaming', () => {
  it('splits text from reasoning', () => {
    const updates = project([
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'answer' } } },
    ])
    expect(updates).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
    ])
  })

  it('drops empty deltas rather than emitting blank chunks', () => {
    expect(project([
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } } },
    ])).toEqual([])
  })
})

describe('tool calls', () => {
  it('opens a card from the real tool/call events', () => {
    const updates = project(eventsOf('tool/call'))
    expect(kinds(updates)).toEqual(['tool_call', 'tool_call'])
    const [first] = updates
    if (first?.sessionUpdate !== 'tool_call') throw new Error('expected a tool_call')
    expect(first.toolCallId).toMatch(/^call_/)
    // The fixture's calls are `skill` invocations; the title should name the
    // skill, not the tool.
    expect(first.title).toBe('brainstorming')
    expect(first.kind).toBe('think')
    expect(first.status).toBe('in_progress')
    expect(first.rawInput).toEqual({ name: 'brainstorming' })
  })

  it('closes the matching card from the real tool/result events', () => {
    const updates = project([...eventsOf('tool/call'), ...eventsOf('tool/result')])
    const opened = updates.filter((u) => u.sessionUpdate === 'tool_call')
    const closed = updates.filter((u) => u.sessionUpdate === 'tool_call_update')
    expect(closed).toHaveLength(opened.length)
    const ids = new Set(opened.map((u) => (u as { toolCallId: string }).toolCallId))
    for (const update of closed) {
      expect(ids).toContain((update as { toolCallId: string }).toolCallId)
      expect((update as { status: string }).status).toBe('completed')
    }
  })

  it('marks an errored result failed', () => {
    const [update] = project([{
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'call_x' },
          content: [{ type: 'tool-result', toolCallId: 'call_x', isError: true, content: [{ type: 'text', text: 'boom' }] }],
        },
      },
    }])
    expect(update).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'call_x', status: 'failed' })
  })

  it('titles a bash call with its command', () => {
    expect(titleOf('bash', { command: 'wc -l index.html', description: 'Count lines' })).toBe('wc -l index.html')
  })

  it('falls back to the tool name rather than dumping JSON', () => {
    expect(titleOf('mystery_tool', { a: 1 })).toBe('mystery_tool')
    expect(titleOf('bash', 'not an object')).toBe('bash')
  })
})

describe('plans', () => {
  it('maps todo_write onto an ACP plan', () => {
    const updates = project(eventsOf('todo/write'))
    expect(kinds(updates)).toEqual(['plan'])
    const [plan] = updates
    if (plan?.sessionUpdate !== 'plan') throw new Error('expected a plan')
    expect(plan.entries.length).toBeGreaterThan(0)
    expect(plan.entries[0]).toMatchObject({ status: 'in_progress' })
    for (const entry of plan.entries) {
      expect(['pending', 'in_progress', 'completed']).toContain(entry.status)
      expect(entry.content.length).toBeGreaterThan(0)
    }
  })
})

describe('resilience', () => {
  it('ignores unknown event types instead of throwing', () => {
    expect(project([
      { type: 'some/future-event', data: { anything: true } },
      { type: 'llm/retry', data: {} },
    ])).toEqual([])
  })

  it('survives malformed payloads', () => {
    expect(() => project([
      { type: 'assistant/chunk' },
      { type: 'assistant/chunk', data: null },
      { type: 'tool/call', data: {} },
      { type: 'tool/result', data: { message: 'not a record' } },
      { type: 'todo/write', data: { todos: 'nope' } },
    ])).not.toThrow()
  })

  it('projects the whole recorded session without throwing', () => {
    const updates = project(fixtures)
    expect(updates.length).toBeGreaterThan(0)
  })
})

describe('user turns', () => {
  const userEvent: DshEvent = {
    type: 'user/message',
    data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
  }

  it('does not echo the prompt back during a live turn', () => {
    // The client just sent this text; echoing it renders the message twice.
    expect(new SessionProjection().onEvent(userEvent)).toEqual([])
  })

  it('replays it when reconstructing a loaded session', () => {
    expect(new SessionProjection({ replay: true }).onEvent(userEvent)).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
    ])
  })

  it('never replays a tool result as a user turn', () => {
    // Tool results are user-role messages in the harness's model and are
    // already rendered as tool cards.
    expect(new SessionProjection({ replay: true }).onEvent({
      type: 'user/message',
      data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'output' }] } },
    })).toEqual([])
  })
})

describe('the inputTokens convention', () => {
  it('reports the whole input, with the cached read a share of it', () => {
    // ACP defines inputTokens as the entire input and cachedReadTokens as the
    // part served from cache; the harness reports inputTokens as the *rest*.
    // A client computing "% cached" as cachedRead/input needs ACP's meaning,
    // so the adapter converts rather than passing the number through.
    const projection = new SessionProjection()
    projection.onEvent({
      type: 'assistant/chunk',
      data: {
        turn: 1, step: 1,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 157, cacheReadTokens: 12_416, cacheWriteTokens: 0, outputTokens: 104, reasoningTokens: 29 },
        },
      },
    })
    const usage = projection.promptUsage()
    expect(usage?.inputTokens).toBe(12_573)
    expect(usage?.cachedReadTokens).toBe(12_416)
    expect(usage!.cachedReadTokens).toBeLessThanOrEqual(usage!.inputTokens)
    expect(usage?.totalTokens).toBe(12_677)
  })
})

describe('session title', () => {
  it('remembers the name the harness gives a conversation', () => {
    const projection = new SessionProjection()
    expect(projection.title).toBeUndefined()
    // Not projected onto the wire — ACP has no title update — but carried so
    // `session/list` rows are not all "Untitled session".
    expect(projection.onEvent({ type: 'session/title', data: { title: '  Add a scoring system  ' } })).toEqual([])
    expect(projection.title).toBe('Add a scoring system')
  })

  it('ignores an empty title rather than blanking a good one', () => {
    const projection = new SessionProjection()
    projection.onEvent({ type: 'session/title', data: { title: 'Real name' } })
    projection.onEvent({ type: 'session/title', data: { title: '   ' } })
    projection.onEvent({ type: 'session/title', data: {} })
    expect(projection.title).toBe('Real name')
  })

  it('takes the title from the recorded session fixtures', () => {
    const projection = new SessionProjection()
    for (const event of fixtures) projection.onEvent(event)
    expect(typeof projection.title).toBe('string')
    expect(projection.title!.length).toBeGreaterThan(0)
  })
})
