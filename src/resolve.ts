/**
 * Reaching the harness's own modules from inside a harness.
 *
 * A plugin like this one is handed the harness's packages through `NODE_PATH`
 * — that is how the host registers it, and how DeepSeek Harness profiles are
 * laid out. **ESM `import()` does not consult `NODE_PATH`**, so a plain
 * `await import('@deepseek-ai/dsh-llm')` fails on every real deployment while
 * succeeding in a checkout where the package happens to be a sibling.
 *
 * That difference is not academic. It is what made this adapter mint user
 * messages with its own fallback rather than the harness's factory, which left
 * every message without an `id`, which made every conversation it ever
 * recorded unreadable. The failure was invisible because the import sat under
 * a bare `catch`.
 *
 * So resolution is explicit here: ask CommonJS resolution, which *does* honour
 * `NODE_PATH` and node_modules lookup, for a real path, then import that path
 * as a URL. What cannot be resolved is reported, never swallowed.
 *
 * @module
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Where to look, in order: `NODE_PATH`, then this module's own neighbourhood. */
const searchPaths = (): string[] => {
  const fromEnv = (process.env['NODE_PATH'] ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter((entry) => entry.length > 0)
  return [...fromEnv, process.cwd()]
}

/** Why a module could not be reached, keyed by specifier. Never thrown away. */
export const resolutionFailures = new Map<string, string>()

/**
 * One of the harness's modules, or undefined when this composition has none.
 *
 * Undefined is a legitimate answer — a test double has no harness packages at
 * all — but the reason is recorded either way, so "not installed" and "on the
 * path but unreadable" stop looking identical.
 */
export const harnessModule = async <T = Record<string, unknown>>(
  specifier: string,
): Promise<T | undefined> => {
  try {
    const require_ = createRequire(import.meta.url)
    const resolved = require_.resolve(specifier, { paths: searchPaths() })
    return (await import(pathToFileURL(resolved).href)) as T
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    resolutionFailures.set(specifier, reason)
    return undefined
  }
}
