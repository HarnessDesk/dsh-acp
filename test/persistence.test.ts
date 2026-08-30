/**
 * Reopening a stored conversation.
 *
 * The harness's own ACP server offers `session/resume` and refuses
 * `session/load`, and ACP keeps the two apart on purpose: **load replays the
 * conversation, resume does not.** A client that draws a transcript — which is
 * every client a person uses — gets a live agent over an empty pane from
 * resume alone. So the thing under test here is the replay: that folding the
 * store's own event log through the projection reconstructs the conversation,
 * and that the log's shape is the *same* shape the live feed carries, which is
 * what makes replay a fold rather than a second mapper.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { isRootConversation } from '../src/plugin.ts'
import { SessionProjection } from '../src/project.ts'
import type { AcpUpdate, DshEvent } from '../src/types.ts'

/** A real session log, recorded from a DeepSeek Harness run. */
const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/session-events.json', import.meta.url), 'utf8'),
) as DshEvent[]

/** What `reopen(..., { replay: true })` does with a stored log. */
const replay = (events: readonly DshEvent[]): AcpUpdate[] => {
  const projection = new SessionProjection({ replay: true })
  const updates: AcpUpdate[] = []
  for (const event of events) {
    try {
      updates.push(...projection.onEvent(event))
    } catch {
      continue
    }
  }
  return updates
}

const kinds = (updates: readonly AcpUpdate[]): string[] =>
  [...new Set(updates.map((update) => update.sessionUpdate))]

describe('replaying a stored conversation', () => {
  it('reconstructs the whole conversation from the store, not just its prose', () => {
    const updates = replay(recorded)
    const seen = kinds(updates)
    // The person's own words come back — without this the reopened pane opens
    // on an answer to a question nobody can see.
    expect(seen).toContain('user_message_chunk')
    expect(seen).toContain('agent_message_chunk')
    // And the work: this is the whole reason not to use the automation server,
    // which emits committed prose and nothing else.
    expect(seen).toContain('tool_call')
    expect(seen).toContain('tool_call_update')
    expect(seen).toContain('plan')
  })

  it('carries the tool call and its result, not just the fact one happened', () => {
    const updates = replay(recorded)
    const call = updates.find((update) => update.sessionUpdate === 'tool_call')
    expect(call).toBeDefined()
    // A row that cannot say what it ran is a row nobody can read.
    expect((call as { title?: string }).title ?? '').not.toEqual('')
    const done = updates.filter((update) => update.sessionUpdate === 'tool_call_update')
    expect(done.length).toBeGreaterThan(0)
    expect(done.some((update) => (update as { status?: string }).status === 'completed')).toBe(true)
  })

  it('recovers the title the harness gave the conversation', () => {
    const projection = new SessionProjection({ replay: true })
    for (const event of recorded) {
      try {
        projection.onEvent(event)
      } catch {
        continue
      }
    }
    // Without this a reopened conversation is "Untitled session" in the list,
    // which is how a person loses track of which one it was.
    expect(projection.title ?? '').not.toEqual('')
  })

  it('skips an event it does not know rather than losing the conversation', () => {
    // The store outlives this adapter's knowledge of it: a log written by a
    // newer harness must reopen, minus whatever is unrecognised.
    const withJunk: DshEvent[] = [
      ...recorded.slice(0, 4),
      { type: 'something/from/the/future' } as unknown as DshEvent,
      null as unknown as DshEvent,
      ...recorded.slice(4),
    ]
    const updates = replay(withJunk)
    expect(kinds(updates)).toContain('tool_call')
    expect(updates.length).toBeGreaterThan(0)
  })

  it('replays a user message only in replay mode', () => {
    // Live, the client already knows what it sent; echoing it would double
    // every prompt in the pane.
    const live = new SessionProjection()
    const user = recorded.find((event) => event.type === 'user/message')
    expect(user).toBeDefined()
    expect(live.onEvent(user as DshEvent)).toEqual([])
    expect(replay([user as DshEvent]).length).toBeGreaterThan(0)
  })
})

describe('isRootConversation', () => {
  it('lists a plain conversation', () => {
    expect(isRootConversation({ id: 's', cwd: '/w', createdAt: 1 })).toBe(true)
  })

  it('leaves out what nobody started as a conversation', () => {
    // A delegated child and a fork are both real sessions in the store, and
    // both would appear in a client's sidebar as conversations the person
    // never opened.
    expect(isRootConversation({ id: 's', cwd: '/w', origin: 'subagent' })).toBe(false)
    expect(isRootConversation({ id: 's', cwd: '/w', parentSession: 'p' })).toBe(false)
  })

  it('leaves out one that names no workspace, because reopening composes there', () => {
    expect(isRootConversation({ id: 's' })).toBe(false)
    expect(isRootConversation({ id: 's', cwd: '' })).toBe(false)
  })
})

describe('the reported version', () => {
  it('matches package.json, because a client shows it and a stale one misleads', async () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const { VERSION } = await import('../src/plugin.ts')
    expect(VERSION).toBe(pkg.version)
  })
})
