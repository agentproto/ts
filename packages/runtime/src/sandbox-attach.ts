/**
 * AIP-36 `sandbox attach` — Phase 1: CONNECT to an already-existing sandbox
 * (Box/e2b/local) without tearing it down.
 *
 * Boot-and-drive (`session-spawn.ts`'s `bootSandboxAgentSession`) boots a
 * box, spawns an adapter ON it, and owns its lifecycle end-to-end. Attach is
 * a different primitive entirely: it's the "rendezvous with my sandbox"
 * verb — resolve the provider, resume the box, ensure its daemon is healthy
 * and reachably exposed, and hand back a durable connection descriptor any
 * MCP client (local Claude, a GitHub Action, another ephemeral sandbox) can
 * use to reach it. It never calls `stop()`/`pause()` — the sandbox it
 * attaches to stays running and addressable exactly as it was.
 *
 * Boot-and-drive's URL is fine to leave ungated: it's ephemeral,
 * provider-owned, and only this process ever learns it. Attach's URL is the
 * opposite — a PERSISTENT address handed to a caller who may be a different
 * process entirely — so it MUST be token-gated. `SandboxBootOpts.expose:
 * "private"` (see `@agentproto/sandbox`) is how attach asks a provider's
 * `connect()` for that; a provider that can't honour it (or a sandbox that
 * wasn't set up to support it) simply doesn't return a token, and this
 * module fails closed rather than emit an ungated URL.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SandboxSpec } from "@agentproto/sandbox"
import { makeSandboxResolver, makeSandboxCredsStore } from "./sandbox-adapters.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"

/**
 * Durable connection descriptor for an attached sandbox — everything a
 * client needs to reach its agentproto daemon directly, without going
 * through this process again.
 */
export interface SandboxConnectionDescriptor {
  /** Sandbox provider slug attached to (e.g. "box", "e2b"). */
  provider: string
  /** Provider-assigned sandbox id. */
  sandboxId: string
  /** The sandbox's `/mcp` endpoint. */
  mcpUrl: string
  /** Opaque secret gating `mcpUrl` — see module docs on why attach always
   *  requires one. How to PRESENT it is provider-specific (`authHeaders`):
   *  Box gates on a `Cookie: _port_auth=<token>`, not a bearer. */
  token?: string
  /** Exact HTTP header(s) a client must send to reach `mcpUrl` — carried
   *  through from `BootedSandbox.authHeaders`. Absent for a token-only
   *  provider, in which case clients (and `buildMcpConfigSnippet`) fall back
   *  to `Authorization: Bearer <token>`. */
  authHeaders?: Record<string, string>
  /** The Origin the daemon's own `--allow-origin` allowlist already trusts
   *  (derived from `mcpUrl`'s own origin) — informational, for a caller
   *  that wants to drive the sandbox from a browser-hosted tool. A
   *  non-browser MCP client (no `Origin` header sent) doesn't need this at
   *  all; the daemon only gates requests that DO carry an Origin header. */
  allowOrigin: string
  /** Whether `AttachSandboxOpts.keepAlive` was requested — informational,
   *  echoing back that the sandbox was (re-)pinned no-auto-stop for the
   *  always-on rendezvous model (provider support permitting). */
  keepAlive: boolean
}

export interface AttachSandboxOpts {
  /** Sandbox provider slug from `list_sandbox_providers` (e.g. "box", "e2b"). */
  provider: string
  /** Provider-assigned sandbox id to attach to. */
  sandboxId: string
  /** Provider-specific `SandboxSpec.config` overrides (e.g. box's `{ port,
   *  workspace }`) — same shape `agent_start.sandbox`'s inline spec takes. */
  config?: Record<string, unknown>
  /**
   * Keep the attached sandbox awake indefinitely for the always-on
   * rendezvous model, instead of leaving it subject to the provider's
   * default idle/TTL auto-stop. Forwarded to `SandboxProvider.connect` as
   * `SandboxBootOpts.keepAlive` — a provider that supports an explicit
   * no-auto-stop assertion (e.g. Box's `ttlSeconds: null`) (re-)applies it
   * defensively; providers with no such concept ignore it.
   */
  keepAlive?: boolean
  /** Injectable resolver — defaults to the same creds-backed resolver
   *  `list_sandbox_providers`/`setup_sandbox_provider` use, reading
   *  `~/.agentproto/sandbox-creds/<slug>.json`. Override for tests. */
  resolveSandboxProvider?: SandboxProviderResolver
}

export type AttachSandboxResult =
  | { ok: true; descriptor: SandboxConnectionDescriptor }
  | {
      ok: false
      code: "sandbox_provider_not_found" | "sandbox_no_connect" | "sandbox_attach_failed" | "sandbox_attach_ungated"
      message: string
    }

/**
 * Resolve `opts.provider`, connect (never boot) to `opts.sandboxId`
 * requesting a private, token-gated exposure, and return a durable
 * descriptor. Never tears down or pauses the sandbox — on any failure past
 * the resolve step, the sandbox is left exactly as `connect()` left it (the
 * providers' own `connect()` implementations are responsible for not
 * leaking partial state; attach adds no teardown of its own).
 */
export async function attachSandbox(opts: AttachSandboxOpts): Promise<AttachSandboxResult> {
  const resolver = opts.resolveSandboxProvider ?? makeSandboxResolver(makeSandboxCredsStore())
  const handle = await resolver(opts.provider)
  if (!handle) {
    return {
      ok: false,
      code: "sandbox_provider_not_found",
      message:
        `sandbox_attach: sandbox provider "${opts.provider}" not found. Check ` +
        "`list_sandbox_providers`, then `setup_sandbox_provider` if it needs credentials.",
    }
  }
  if (!handle.provider.connect) {
    return {
      ok: false,
      code: "sandbox_no_connect",
      message:
        `sandbox_attach: provider "${opts.provider}" has no connect() — it can only boot ` +
        "fresh sandboxes, not attach to an existing one.",
    }
  }

  const spec: SandboxSpec = { provider: opts.provider, config: opts.config ?? {} }

  let booted
  try {
    booted = await handle.provider.connect(opts.sandboxId, spec, {
      env: {},
      expose: "private",
      keepAlive: opts.keepAlive,
    })
  } catch (err) {
    return {
      ok: false,
      code: "sandbox_attach_failed",
      message:
        `sandbox_attach: connect failed for provider "${opts.provider}" sandbox ` +
        `"${opts.sandboxId}" — ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!booted.token) {
    return {
      ok: false,
      code: "sandbox_attach_ungated",
      message:
        `sandbox_attach: provider "${opts.provider}" did not return a token-gated URL for ` +
        `sandbox "${opts.sandboxId}" — refusing to emit an ungated persistent daemon URL.`,
    }
  }

  return {
    ok: true,
    descriptor: {
      provider: opts.provider,
      sandboxId: booted.sandboxId,
      mcpUrl: booted.mcpUrl,
      token: booted.token,
      ...(booted.authHeaders ? { authHeaders: booted.authHeaders } : {}),
      allowOrigin: new URL(booted.mcpUrl).origin,
      keepAlive: opts.keepAlive ?? false,
    },
  }
}

/** Paste-ready `.mcp.json` (Claude Code project-scope MCP config) entry for
 *  a connection descriptor — http transport, with the provider's own auth
 *  header(s) when gated (e.g. Box's `Cookie: _port_auth=…`), falling back to
 *  `Authorization: Bearer <token>` for a token-only provider. */
export function buildMcpConfigSnippet(
  descriptor: SandboxConnectionDescriptor,
): { mcpServers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }> } {
  const name = `sandbox-${descriptor.provider}-${descriptor.sandboxId}`
  const headers = descriptor.authHeaders
    ? descriptor.authHeaders
    : descriptor.token
      ? { Authorization: `Bearer ${descriptor.token}` }
      : undefined
  return {
    mcpServers: {
      [name]: {
        type: "http",
        url: descriptor.mcpUrl,
        ...(headers ? { headers } : {}),
      },
    },
  }
}

export interface RegisterSandboxAttachToolOptions {
  /** Same injection seam as `AttachSandboxOpts.resolveSandboxProvider` —
   *  pass the daemon's shared resolver so this tool sees the same provider
   *  set as `list_sandbox_providers`/`agent_start.sandbox`. */
  resolveSandboxProvider?: SandboxProviderResolver
}

/** Register the `sandbox_attach` MCP tool. */
export function registerSandboxAttachTool(
  server: McpServer,
  opts: RegisterSandboxAttachToolOptions = {},
): void {
  server.tool(
    "sandbox_attach",
    "Connect to an ALREADY-EXISTING sandbox (Box/e2b) without tearing it down — resumes it, " +
      "ensures its agentproto daemon is healthy and reachably exposed, and returns a durable, " +
      "token-gated connection descriptor (plus a paste-ready .mcp.json snippet) any MCP " +
      "client can use to reach it directly. Never stops or pauses the sandbox. Use " +
      "`list_sandbox_providers` to see available providers and `setup_sandbox_provider` to " +
      "configure credentials first.",
    {
      provider: z.string().describe('Sandbox provider slug, e.g. "box" or "e2b".'),
      sandboxId: z.string().describe("Provider-assigned sandbox id to attach to."),
      config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific SandboxSpec config overrides (e.g. box's { port, workspace })."),
      keepAlive: z
        .boolean()
        .optional()
        .describe(
          "Keep the sandbox awake indefinitely for an always-on rendezvous, instead of leaving it " +
            "subject to the provider's default idle/TTL auto-stop (e.g. pins Box's ttlSeconds to null).",
        ),
    },
    async input => {
      const result = await attachSandbox({
        provider: input.provider,
        sandboxId: input.sandboxId,
        ...(input.config ? { config: input.config as Record<string, unknown> } : {}),
        ...(input.keepAlive !== undefined ? { keepAlive: input.keepAlive } : {}),
        ...(opts.resolveSandboxProvider ? { resolveSandboxProvider: opts.resolveSandboxProvider } : {}),
      })
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.message, code: result.code }) }],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              descriptor: result.descriptor,
              mcpConfig: buildMcpConfigSnippet(result.descriptor),
            }),
          },
        ],
      }
    },
  )
}
