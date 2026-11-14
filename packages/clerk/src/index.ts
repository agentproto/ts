/**
 * @agentproto/clerk: the AIP-68 clerk pass.
 *
 * The daemon-side steward/secretary: when a session finishes a turn, the
 * daemon may run ONE clerk pass over that session's context after an idle
 * debounce. This package carries the hook configuration, the turn-end
 * subscriber that decides when to fire, and the runner that launches the
 * configured routine or command.
 *
 * @see https://agentproto.sh/docs/aip-68
 */

export const SPEC_NAME = "clerk/v1" as const

export {
  CLERK_HOOK_DEFAULTS,
  CLERK_HOOK_DEFAULT_DEBOUNCE_MS,
  CLERK_HOOK_EVENTS,
  clerkHookInputSchema,
  clerkHooksInputSchema,
  loadDaemonClerkHook,
  loadWorkspaceClerkHook,
  mergeClerkHookLevels,
  parseAgentClerkHook,
  parseClerkHookLevel,
  resolveClerkHookConfig,
} from "./clerk-hook-config.js"
export type {
  ClerkHookConfig,
  ClerkHookEvent,
  ClerkHookRun,
  ClerkHookSource,
  ResolvedClerkHookConfig,
} from "./clerk-hook-config.js"
export { createClerkTurnEndController } from "./clerk-turn-end.js"
export type {
  ClerkPassInput,
  ClerkSessionEventBus,
  ClerkSessionLike,
  ClerkTurnEndController,
  ClerkTurnEndControllerOptions,
  ClerkTurnEndEvent,
} from "./clerk-turn-end.js"
export { createClerkPassRunner, spawnClerkCommand } from "./clerk-pass-runner.js"
export type {
  ClerkCommandSpec,
  ClerkPassRunnerOptions,
} from "./clerk-pass-runner.js"
