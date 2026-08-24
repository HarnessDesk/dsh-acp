/**
 * `@harnessdesk/dsh-acp` — a complete Agent Client Protocol server for
 * DeepSeek Harness.
 * @module
 */
export { apply, inject, name, refuseToolServers } from './plugin.ts'
export { SessionProjection, titleOf } from './project.ts'
export { EFFORTS, MODES, sessionConfigOptions, type AdapterConfig, type ConfigOption } from './options.ts'
export type { AcpUpdate, AcpUsage, DshEvent } from './types.ts'
