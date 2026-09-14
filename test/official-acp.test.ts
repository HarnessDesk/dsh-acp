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
  const cwd = await mkdtemp(join(tmpdir(), 'harnessdesk-official-cwd-'))
  const child = spawn(bin, args, {
    cwd: process.env['DSH_OFFICIAL_CWD'] ?? process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let buffer = ''
  let nextId = 0
  let stderr = ''
  let processError: Error | undefined
  const pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.once('error', (error) => {
    processError = error
    rejectPending(error)
  })
  child.once('exit', (code, signal) => {
    processError = new Error(`official ACP exited (${code ?? signal}); stderr: ${stderr}`)
    rejectPending(processError)
  })
  child.stdin.on('error', (error) => {
    processError = error
    rejectPending(error)
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
      let message: JsonObject
      try {
        message = JSON.parse(line) as JsonObject
      } catch {
        continue
      }
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

  const call = (method: string, params: JsonObject): Promise<JsonObject> => new Promise((resolve, reject) => {
    const stopped = processError ?? (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed
      ? new Error(`official ACP exited before ${method}; stderr: ${stderr}`)
      : undefined)
    if (stopped !== undefined) {
      reject(stopped)
      return
    }
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out; stderr: ${stderr}`))
    }, 20_000)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error == null) return
        const request = pending.get(id)
        if (request === undefined) return
        pending.delete(id)
        request.reject(error)
      })
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      let softTimer: ReturnType<typeof setTimeout> | undefined
      let hardTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (softTimer !== undefined) clearTimeout(softTimer)
        if (hardTimer !== undefined) clearTimeout(hardTimer)
        child.removeListener('exit', finish)
        resolve()
      }
      child.once('exit', finish)
      softTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          finish()
          return
        }
        child.kill('SIGKILL')
        hardTimer = setTimeout(finish, 1_000)
      }, 1_000)
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
    await stop()
    await rm(cwd, { recursive: true, force: true })
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
