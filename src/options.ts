/**
 * The session controls this adapter offers a client.
 *
 * ACP carries these as `configOptions`, and their `category` decides where a
 * client files them: `model` in a model picker, `thought_level` next to it,
 * `mode` with the permission controls. The categories below are the four ACP
 * names, so a client that already understands the vocabulary needs no special
 * case for this agent.
 *
 * @module
 */

/** How the adapter was configured when it was mounted. */
export interface AdapterConfig {
  /** Provider route for created agents, e.g. `deepseek-official`. */
  readonly provider?: string
  /** Model for created agents, e.g. `deepseek-v4-pro`. */
  readonly model?: string
  /** Models to offer. A single-entry list is not offered at all. */
  readonly models?: readonly string[]
  /** Reasoning levels to offer. */
  readonly efforts?: readonly string[]
  /** Test transport; production uses stdio. */
  readonly stream?: unknown
}

/** DeepSeek's own reasoning levels, in the adapter's display order. */
export const EFFORTS = ['off', 'low', 'high', 'max'] as const

/** The harness's sandbox modes, which ACP files under `mode`. */
export const MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

const LABELS: Readonly<Record<string, string>> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
  off: 'Off',
  low: 'Low',
  high: 'High',
  max: 'Max',
}

const label = (id: string): string =>
  LABELS[id] ?? id.replace(/(^|[-_])([a-z])/g, (_, sep: string, ch: string) => `${sep ? ' ' : ''}${ch.toUpperCase()}`)

export interface ConfigOption {
  readonly type: 'select'
  readonly id: string
  readonly name: string
  readonly category: 'model' | 'thought_level' | 'mode'
  readonly currentValue: string
  readonly options: readonly { readonly value: string; readonly name: string }[]
}

/**
 * The options a `session/new` response should carry. A control with fewer
 * than two choices is omitted: offering a picker with one entry is noise.
 */
/**
 * Which controls this composition can actually honour.
 *
 * Not a preference — a fact discovered at session setup. A composition whose
 * agent module will not couple a model selection cannot change the route, and
 * one with no sandbox policy cannot change the permission mode. Offering the
 * picker anyway is the exact failure this module exists to avoid: it draws,
 * it accepts a choice, and then it errors.
 */
export interface ControlSupport {
  /** The agent accepted a coupled model selection, so route changes land. */
  readonly route?: boolean
  /** A sandbox policy is mounted, so the permission mode can be switched. */
  readonly mode?: boolean
}

export const sessionConfigOptions = (
  config: AdapterConfig,
  /**
   * What the client has already chosen for this session, by option id.
   *
   * A picker that forgets the choice the moment it is made reads as a control
   * that did nothing, which is indistinguishable from one that is broken.
   */
  chosen: ReadonlyMap<string, string> = new Map(),
  /**
   * What this session can honour. Defaults to everything, because the pure
   * shape of the list is what the tests describe; a live session passes what
   * it actually installed.
   */
  support: ControlSupport = { route: true, mode: true },
): ConfigOption[] => {
  const out: ConfigOption[] = []
  const models = config.models ?? []
  if (support.route !== false && models.length >= 2) {
    out.push({
      type: 'select', id: 'model', name: 'Model', category: 'model',
      currentValue: chosen.get('model') ?? config.model ?? models[0]!,
      options: models.map((value) => ({ value, name: label(value) })),
    })
  }
  const efforts = config.efforts ?? EFFORTS
  if (support.route !== false && efforts.length >= 2) {
    out.push({
      type: 'select', id: 'effort', name: 'Reasoning', category: 'thought_level',
      currentValue: chosen.get('effort') ?? (efforts.includes('high') ? 'high' : efforts[0]!),
      options: efforts.map((value) => ({ value, name: label(value) })),
    })
  }
  if (support.mode !== false) {
    out.push({
      type: 'select', id: 'mode', name: 'Permissions', category: 'mode',
      currentValue: chosen.get('mode') ?? 'workspace-write',
      options: MODES.map((value) => ({ value, name: label(value) })),
    })
  }
  return out
}
