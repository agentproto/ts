/**
 * AIP-36 sandbox-backed `AgentSessionHost`.
 *
 * The seam an `AgentStep` binds against (`AgentSessionHost`,
 * `@agentproto/workflow-runtime`) is already satisfiable by a *remote*
 * daemon via `connectDaemonAgentSessionHost` (`@agentproto/worktree`) —
 * it just needs a reachable MCP URL. So running a coding-agent step
 * inside a sandbox is: boot a provider-specific box that exposes an
 * agentproto daemon's MCP endpoint as a URL, then hand that URL to the
 * daemon host unchanged. No new session-host implementation, no
 * bespoke spawn/prompt plumbing — this module only wires secrets → env
 * → `provider.boot` → `connectDaemonAgentSessionHost`.
 */

import { assertSafeSecretValue, type SecretResolver } from "@agentproto/secrets/exposure"
import { connectDaemonAgentSessionHost, type DaemonAgentSessionHost } from "@agentproto/worktree"
import type { SandboxHandle } from "./types.js"

/** AIP-36 sandbox manifest handle — provider id, config, env passthrough, limits. */
export type SandboxSpec = SandboxHandle

/** What a `SandboxProvider` hands back once the box is up and reachable. */
export interface BootedSandbox {
  /** The booted agentproto daemon's MCP endpoint, reachable from this process. */
  mcpUrl: string
  /** Provider-assigned sandbox id, for logging / lookup. */
  sandboxId: string
  /** Tear down the sandbox. */
  stop(): Promise<void>
  /** Pause the sandbox instead of killing it — keeps it reconnectable via
   *  `SandboxProvider.connect(sandboxId, ...)` later. Optional: providers
   *  that can't pause (or don't support reconnect at all) omit it; callers
   *  that want to pause fall back to `stop()` when it's absent. */
  pause?(): Promise<void>
}

/** Env resolved from secrets, handed to `provider.boot`. */
export interface SandboxBootOpts {
  env: Record<string, string>
}

/**
 * Backend-agnostic sandbox lifecycle. Concrete implementations (e2b, modal,
 * daytona, blaxel, …) live in their own packages so this one stays free of
 * vendor SDK dependencies — see `@agentproto/sandbox-e2b`.
 */
export interface SandboxProvider {
  boot(spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox>
  /** Reconnect to an already-booted (possibly paused) sandbox instead of
   *  booting a fresh one — the reuse path (`agent_start.sandbox.reuse`).
   *  Optional: providers that can't reconnect (e.g. the `local` passthrough,
   *  which tears down its temp workspace on `stop()`) omit it; the runtime
   *  errors clearly when reuse is requested against such a provider. */
  connect?(sandboxId: string, spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox>
}

/** Which secrets to resolve into the sandbox's env, and how. */
export interface SandboxSecretsConfig {
  /** Secret slugs to resolve (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`). */
  slugs: readonly string[]
  /** Resolves a slug to its value. Defaults to reading `process.env[slug]`. */
  resolver?: SecretResolver
}

export interface CreateSandboxAgentSessionHostOpts {
  provider: SandboxProvider
  spec: SandboxSpec
  secrets: SandboxSecretsConfig
  /** Reconnect to this existing sandbox id instead of booting a fresh box —
   *  requires `provider.connect`; throws a clear error otherwise. */
  sandboxId?: string
}

export type SandboxAgentSessionHost = DaemonAgentSessionHost & {
  /** Provider-assigned sandbox id (`BootedSandbox.sandboxId`) — surfaced so a
   *  caller can record it (there's no local PID for a sandboxed session). */
  sandboxId: string
  /** Close the daemon connection AND tear down the sandbox. */
  stop(): Promise<void>
  /** Close the daemon connection and PAUSE the sandbox instead of killing
   *  it — only present when the booted sandbox supports `pause()`. */
  pause?(): Promise<void>
}

/**
 * Resolve `secrets` into an env map, boot (or, when `opts.sandboxId` is set,
 * reconnect to) the sandbox with it, then connect the #202 daemon host to
 * the sandbox's exposed MCP URL. `stop()` closes the daemon connection
 * before tearing down the sandbox (never leaks the box on a client-side
 * error); `pause()` does the same but pauses rather than kills.
 */
export async function createSandboxAgentSessionHost(
  opts: CreateSandboxAgentSessionHostOpts,
): Promise<SandboxAgentSessionHost> {
  const env = await resolveSandboxSecretsEnv(opts.secrets)
  let booted: BootedSandbox
  if (opts.sandboxId !== undefined) {
    if (!opts.provider.connect) {
      throw new Error(
        `createSandboxAgentSessionHost: reuse requested for sandbox "${opts.sandboxId}", ` +
          "but this provider has no connect() — it can only boot fresh sandboxes.",
      )
    }
    booted = await opts.provider.connect(opts.sandboxId, opts.spec, { env })
  } else {
    booted = await opts.provider.boot(opts.spec, { env })
  }
  let host: DaemonAgentSessionHost
  try {
    host = await connectDaemonAgentSessionHost({ url: booted.mcpUrl })
  } catch (err) {
    await booted.stop()
    throw err
  }
  return {
    ...host,
    sandboxId: booted.sandboxId,
    async stop(): Promise<void> {
      await host.close()
      await booted.stop()
    },
    ...(booted.pause
      ? {
          async pause(): Promise<void> {
            await host.close()
            await booted.pause!()
          },
        }
      : {}),
  }
}

const defaultProcessEnvResolver: SecretResolver = name => process.env[name] ?? null

/** Resolve every configured slug, failing loudly (no silent gaps in the sandbox env). */
async function resolveSandboxSecretsEnv(
  config: SandboxSecretsConfig,
): Promise<Record<string, string>> {
  const resolver = config.resolver ?? defaultProcessEnvResolver
  const env: Record<string, string> = {}
  for (const slug of config.slugs) {
    const value = await resolver(slug)
    if (value === null || value === undefined) {
      throw new Error(
        `createSandboxAgentSessionHost: missing secret "${slug}" — set it in the ` +
          "host process's environment, or pass a resolver that can supply it.",
      )
    }
    assertSafeSecretValue(slug, value)
    env[slug] = value
  }
  return env
}
