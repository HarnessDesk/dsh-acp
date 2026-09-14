import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type JsonObject = Record<string, unknown>

const officialBin = process.env['DSH_OFFICIAL_BIN']

const jsonArgs = (): string[] => {
  const raw = process.env['DSH_OFFICIAL_ARGS']
  if (raw === undefined) return ['--profile', 'acp']
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('DSH_OFFICIAL_ARGS must be a JSON string array')
  }
  return parsed
}

const callOfficial = async (bin: string, args: readonly string[]): Promise<JsonObject> => {
  const dshHome = process.env['DSH_HOME'] ?? await mkdtemp(join(tmpdir(), 'harnessdesk-official-acp-'))
  const cwd = await mkdtemp(join(tmpdir(), 'harnessdesk-official-cwd-'))
  const child = spawn(bin, args, {
    cwd: process.env['DSH_OFFICIAL_CWD'] ?? process.cwd(),
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let buffer = ''
  let nextId = 0
  let stderr = ''
  const pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.once('error', (error) => rejectPending(error))
  child.once('exit', (code, signal) => {
    if (code !== 0 || signal !== null) {
      rejectPending(new Error(`official ACP exited (${code ?? signal}); stderr: ${stderr}`))
    }
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      const message = JSON.parse(line) as JsonObject
      const id = message['id']
      if (typeof id !== 'number') continue
      const request = pending.get(id)
      if (request === undefined) continue
      pending.delete(id)
      const error = message['error']
      if (error !== undefined) request.reject(new Error(JSON.stringify(error)))
      else request.resolve((message['result'] ?? {}) as JsonObject)
    }
  })

  const call = (method: string, params: JsonObject): Promise<JsonObject> => {
    const id = ++nextId
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out; stderr: ${stderr}`))
      }, 20_000)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
  }

  try {
    const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    expect(initialized['protocolVersion']).toBeDefined()
    expect(initialized['agentCapabilities']).toBeDefined()

    const session = await call('session/new', { cwd, mcpServers: [] })
    expect(session['sessionId']).toEqual(expect.any(String))
    expect(session['configOptions']).toEqual(expect.any(Array))
    expect(session).not.toHaveProperty('replayed')
    return session
  } finally {
    rejectPending(new Error('official ACP process stopped'))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
    await rm(cwd, { recursive: true, force: true })
    if (process.env['DSH_HOME'] === undefined) await rm(dshHome, { recursive: true, force: true })
  }
}

describe('DeepSeek official ACP automation compatibility', () => {
  it.skipIf(officialBin === undefined)(
    'supports the automation session boundary without UI-only replay fields',
    async () => {
      await callOfficial(officialBin!, jsonArgs())
    },
    30_000,
  )
})
