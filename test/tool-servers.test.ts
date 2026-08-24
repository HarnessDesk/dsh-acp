/**
 * The MCP tool-server refusal.
 *
 * Small, but the reason it exists is not: this adapter used to take a
 * non-empty `mcpServers` and ignore it, which left the client believing its
 * tools had reached the model. The rule under test is that saying no is the
 * only honest answer, and that the refusal names the parameter — which is how
 * a client recognises it and retries without the server.
 */
import { describe, expect, it } from 'vitest'
import { refuseToolServers } from '../src/plugin.ts'

const server = { name: 'harnessdesk-tools', command: '/bin/true', args: [], env: [] }

describe('refuseToolServers', () => {
  it('refuses a non-empty mcpServers, naming the parameter', () => {
    let message = ''
    try {
      refuseToolServers({ mcpServers: [server] })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // The client matches on the parameter name; a refusal that does not say
    // `mcpServers` reads as an ordinary failure and takes the session with it.
    expect(message).toMatch(/mcpServers/)
    // And it says where the servers actually go, so the answer is actionable.
    expect(message).toMatch(/cordis\.yml/)
  })

  it('lets a session with no tool server through untouched', () => {
    expect(() => refuseToolServers({})).not.toThrow()
    expect(() => refuseToolServers({ mcpServers: [] })).not.toThrow()
    // A malformed value is not an offer of tools, and must not fail a session.
    expect(() => refuseToolServers({ mcpServers: 'nonsense' })).not.toThrow()
  })
})
