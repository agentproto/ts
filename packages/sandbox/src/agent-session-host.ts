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

/**
 * Thrown when a caller requests port exposure on a `BootedSandbox` whose
 * provider does not support it — i.e. the sandbox handle has no `expose()`
 * method. Callers should check for `expose` before calling it, or catch
 * this error and fall back gracefully.
 */
export class SandboxPortExposureUnsupportedError extends Error {
  constructor(message?: string) {
    super(message ?? "This sandbox provider does not support port exposure.")
    this.name = "SandboxPortExposureUnsupportedError"
  }
}

/** What a `SandboxProvider` hands back once the box is up and reachable. */
export interface BootedSandbox {
  /** The booted agentproto daemon's MCP endpoint, reachable from this process. */
  mcpUrl: string
  /** Provider-assigned sandbox id, for logging / lookup. */
  sandboxId: string
  /** Opaque secret gating `mcpUrl`, present when `opts.expose === "private"`
   *  was honoured (see `SandboxBootOpts.expose`). Absent for the default
   *  public-exposure path (boot-and-drive) and for providers/paths that
   *  can't gate the port at all — a caller that needs a gated URL (e.g.
   *  `attachSandbox`) MUST treat a missing token as "not gated", not as
   *  "no auth needed". The token is the raw secret; how a client must
   *  PRESENT it (bearer header, cookie, …) is provider-specific — see
   *  `authHeaders`. */
  token?: string
  /** Exact HTTP header(s) a client must send to authenticate against the
   *  gated `mcpUrl` — the provider's own answer to "how do I present the
   *  token". Box, for instance, gates its private hostname with a
   *  `Cookie: _port_auth=<token>` (verified live: bearer/query are ignored,
   *  the port edge only honours the cookie), so it returns that here rather
   *  than leaving the caller to guess a scheme. Present iff `token` is; a
   *  token-only provider that omits this is treated by `buildMcpConfigSnippet`
   *  as `Authorization: Bearer <token>`. */
  authHeaders?: Record<string, string>
  /**
   * Expose an app port on the sandbox and return its public URL. E2B returns
   * `https://<port>-<sandboxId>.e2b.app`. Loopback bind is enough inside the
   * VM — the provider's edge handles the forwarding.
   *
   * Optional: providers that cannot expose arbitrary ports omit this method.
   * Callers should check for presence before calling, or catch
   * `SandboxPortExposureUnsupportedError` when using `exposePort()`.
   */
  expose?(port: number): Promise<{ url: string }>
  /**
   * Ports resolved at boot time from `SandboxSpec.extraPorts` — a map of
   * port number to public URL. Only present when the spec declared
   * `extraPorts` AND the provider supports exposure. Callers that need a
   * port URL at runtime should use `expose()` directly when this map is
   * absent or doesn't include the target port.
   */
  ports?: Record<number, string>
  /** Tear down the sandbox. */
  stop(): Promise<void>
  /** Pause the sandbox instead of killing it — keeps it reconnectable via
   *  `SandboxProvider.connect(sandboxId, ...)` later. Optional: providers
   *  that can't pause (or don't support reconnect at all) omit it; callers
   *  that want to pause fall back to `stop()` when it's absent. */
  pause?(): Promise<void>
}

/**
 * Expose a port on a booted sandbox. Throws `SandboxPortExposureUnsupportedError`
 * when the provider's sandbox handle has no `expose()` method.
 */
export async function exposePort(booted: BootedSandbox, port: number): Promise<{ url: string }> {
  if (!booted.expose) {
    throw new SandboxPortExposureUnsupportedError(
      `sandbox "${booted.sandboxId}" does not support port exposure — ` +
        "the provider has no expose() implementation.",
    )
  }
  return booted.expose(port)
}

/** Env resolved from secrets, handed to `provider.boot`. */
export interface SandboxBootOpts {
  env: Record<string, string>
  /**
   * How the provider should expose the daemon's port. `"public"` (the
   * default when omitted) is boot-and-drive's ephemeral, provider-owned,
   * ungated URL. `"private"` asks the provider for a PERSISTENT,
   * token-gated URL instead — set by `attachSandbox`, which produces a
   * durable connection descriptor and must never emit an ungated one.
   * Providers that don't support gating simply ignore this and omit
   * `BootedSandbox.token`; the caller is responsible for treating that as
   * a failure when it needed a gated URL.
   */
  expose?: "public" | "private"
  /**
   * Keep the sandbox awake indefinitely for the always-on rendezvous model
   * — set by `attachSandbox` when its own `keepAlive` opt is true. A
   * provider that supports an explicit no-auto-stop/no-expiry assertion
   * (e.g. Box's `ttlSeconds: null`) should (re-)apply it as part of
   * `connect()`, defensively, even if the sandbox already defaults to it.
   * Providers with no such concept simply ignore this.
   */
  keepAlive?: boolean
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
  /** Ports resolved at boot from `SandboxSpec.extraPorts` — forwarded from
   *  `BootedSandbox.ports` so the runtime can record them on the session
   *  descriptor without reaching into the booted handle after the fact. */
  ports?: Record<number, string>
  /** Expose an app port and return its public URL — forwarded from
   *  `BootedSandbox.expose`. Absent when the provider doesn't support it. */
  expose?: BootedSandbox["expose"]
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
    ...(booted.ports ? { ports: booted.ports } : {}),
    ...(booted.expose ? { expose: booted.expose.bind(booted) } : {}),
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
