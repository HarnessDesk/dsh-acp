#!/usr/bin/env node
/**
 * `harnessdesk-dsh-acp [--config <composition.cordis.yml>]`
 *
 * Boots a DeepSeek Harness composition and serves ACP over this process's
 * stdio. The composition decides everything about the agent — model, tools,
 * sandbox policy, credentials — and must mount this package's plugin, which
 * is what turns the harness's session events into protocol traffic.
 *
 * Stdout carries JSON-RPC frames and nothing else; diagnostics go to stderr.
 * A composition with a stdout logger in it will corrupt the wire, which is
 * why the harness's own compositions omit one.
 *
 * @module
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const NAME = 'harnessdesk-dsh-acp'

/**
 * Node 24.0–24.11.1, where a harness older than 0.1.2-alpha.2 cannot boot.
 *
 * Compared as numbers, not by string order: `'24.9.0' < '24.12.0'` is false
 * lexicographically, which would have excluded exactly the versions this is
 * meant to catch.
 */
const inBrokenLoaderWindow = (): boolean => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major === 24 && minor < 12
}

const fail = (message: string): never => {
  process.stderr.write(`${NAME}: ${message}\n`)
  process.exit(2)
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})

const config = values.config ?? './cordis.yml'

// `dsh-app-boot` owns env layering, Loader guards, and settled-tree boot.
//
// Resolving it is fiddlier than it looks. This adapter is installed *beside*
// a harness, not inside one, so a bare `import` resolves from this file's own
// directory and finds nothing. The harness may be the process's working
// directory, or a sibling of the composition it was pointed at, or on the
// global path. We try each in turn and use the first that answers, rather
// than demanding one layout — a bare specifier alone silently works under
// `tsx` (whose resolver consults the cwd) and fails under plain `node`, which
// is exactly the kind of difference that only shows up in production.
const bases = [
  process.cwd(),
  dirname(resolve(config)),
  fileURLToPath(import.meta.url),
]

const resolveFrom = (specifier: string): string | undefined => {
  for (const base of bases) {
    try {
      return createRequire(join(base, 'noop.js')).resolve(specifier)
    } catch {
      continue
    }
  }
  return undefined
}

interface AppBoot {
  boot(name: string, path: string): Promise<unknown>
  resolveConfigPath(path: string, mode?: string): string
  loadEnv(name: string): void
  installFailLoud?(name: string): void
}

const bootSpecifier = ['@deepseek-ai', 'dsh-app-boot'].join('/')
const bootPath = resolveFrom(bootSpecifier)
if (bootPath === undefined) {
  fail(
    `cannot start: ${bootSpecifier} is not resolvable from the working directory ` +
      `(${process.cwd()}), from the composition at ${resolve(config)}, or from this package. ` +
      `Run this adapter from a DeepSeek Harness installation, or set the working ` +
      `directory to one.`,
  )
}

const mod = (await import(pathToFileURL(bootPath!).href)) as AppBoot
mod.installFailLoud?.(NAME)
const { boot, resolveConfigPath, loadEnv } = mod

loadEnv(NAME)
try {
  await boot(NAME, resolveConfigPath(config))
} catch (error) {
  // A boot failure on Node 24.0–24.11.1 has one overwhelmingly likely cause
  // that has nothing to do with the composition, and the stack trace names
  // this binary rather than the culprit.
  //
  // `@deepseek-ai/cordis-plugin-loader` classified Node's internal ESM loader
  // by major version — `>= 24` meant "v2" — but v2 only landed in **24.12.0**.
  // Every 24.0–24.11.1 loader was therefore mistagged and `resolveSync` was
  // called with reversed parameters, which breaks the plugin tree before any
  // of this adapter's code runs. Fixed in loader 1.0.3, which ships with
  // DeepSeek Harness 0.1.2-alpha.2 and later.
  //
  // The hint is appended rather than substituted: the original error is still
  // the evidence, and this window is only *likely* to be the cause, never
  // certainly.
  if (inBrokenLoaderWindow()) {
    process.stderr.write(
      `\n${NAME}: note — this is Node ${process.versions.node}, and DeepSeek Harness ` +
        `installations older than 0.1.2-alpha.2 fail to boot on Node 24.0–24.11.1: ` +
        `@deepseek-ai/cordis-plugin-loader below 1.0.3 mistakes that range for a newer ` +
        `module loader. If the error above came from the plugin tree rather than from ` +
        `your composition, upgrade the harness (or run Node 24.12+ or Node 22).\n`,
    )
  }
  throw error
}
