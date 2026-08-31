/**
 * The stop button.
 *
 * This adapter asked a live agent to `abort()`. `@deepseek-ai/dsh-agent` has
 * no such method — it has `cancel(cause)` — and an optional call to a method
 * that is not there does nothing at all, silently. So stop reported success
 * to the client, the model kept running, and the turn ended whenever it
 * would have ended anyway.
 */
import { describe, expect, it } from 'vitest'
import { stopAgent } from '../src/harness.ts'

describe('stopAgent', () => {
  it("calls the live harness's cancel, with the cause a person means", () => {
    const causes: unknown[] = []
    const agent = { cancel: (cause: unknown) => causes.push(cause) }
    expect(stopAgent(agent)).toBe(true)
    expect(causes).toEqual([{ kind: 'user' }])
  })

  it('falls back to abort where that is all a tree offers', () => {
    let aborted = 0
    expect(stopAgent({ abort: () => { aborted += 1 } })).toBe(true)
    expect(aborted).toBe(1)
  })

  it('prefers cancel when an agent somehow has both', () => {
    let cancelled = 0
    let aborted = 0
    stopAgent({ cancel: () => { cancelled += 1 }, abort: () => { aborted += 1 } })
    expect([cancelled, aborted]).toEqual([1, 0])
  })

  it('reports that it could not stop, rather than pretending it did', () => {
    // The whole bug in one line: an agent with neither method used to be
    // indistinguishable from one that stopped.
    expect(stopAgent({})).toBe(false)
  })
})
