/**
 * Spawn-time secret exposure resolution.
 *
 * Builds a CredentialBroker over `~/.agentproto/credentials.json`, resolves
 * `EnvExposure` values into a scoped env map, and rewrites `McpHeaderExposure`
 * entries into local daemon-side proxies that inject the broker-resolved
 * `Authorization` header upstream.
 */

import { z } from "zod"
import type { AcpMcpServer } from "@agentproto/acp"
import { CredentialBroker, getAuthProvider, CredentialsJsonStore } from "@agentproto/auth"
import {
  isExposureKind,
  resolveMcpHeaderExposure,
  assertSafeSecretValue,
  type EnvExposure,
  type McpHeaderExposure,
  type McpHeaderResolver,
  type SecretExposure,
} from "@agentproto/secrets/exposure"
import { createAuthedMcpProxy, type AuthedMcpProxy } from "./mcp-proxy.js"

/** MCP server entry at spawn time — extends the ACP shape with an optional
 *  broker path for header-injected upstream proxies. */
export interface SpawnMcpServerEntry extends AcpMcpServer {
  credentialPath?: string
}

export const spawnMcpServerEntrySchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  ref: z.string().optional(),
  credentialPath: z.string().optional(),
})

const envExposureSchema = z.object({
  kind: z.literal("env"),
  name: z.string(),
  field: z.string(),
})

const fileExposureSchema = z.object({
  kind: z.literal("file"),
  path: z.string(),
  field: z.string().optional(),
  mode: z.number().optional(),
})

const egressSubstituteExposureSchema = z.object({
  kind: z.literal("egress-substitute"),
  placeholderName: z.string(),
  allowedByDefault: z.boolean(),
  intendedProviders: z.array(z.string()).optional(),
})

const mcpHeaderExposureSchema = z.object({
  kind: z.literal("mcp-header"),
  credentialPath: z.string(),
  server: z.string().optional(),
})

/** Zod mirror of the `@agentproto/secrets/exposure` union. */
export const secretExposureSchema = z.union([
  envExposureSchema,
  fileExposureSchema,
  egressSubstituteExposureSchema,
  mcpHeaderExposureSchema,
])

/** Resolves an `EnvExposure` field to its string value. */
export type ResolveEnvValue = (
  field: string,
) => Promise<string | undefined> | string | undefined

function defaultEnvResolver(field: string): string | undefined {
  return process.env[field]
}

/** Resolve a single `EnvExposure` into `{ name, value }`, guarding the value. */
export async function resolveEnvExposure(
  exposure: EnvExposure,
  resolveValue: ResolveEnvValue = defaultEnvResolver,
): Promise<{ name: string; value: string }> {
  const raw = await resolveValue(exposure.field)
  if (raw === undefined || raw === null) {
    throw new Error(
      `env exposure "${exposure.name}": could not resolve field "${exposure.field}"`,
    )
  }
  assertSafeSecretValue(exposure.name, raw)
  return { name: exposure.name, value: raw }
}

/** Build the default spawn-time broker backed by `~/.agentproto/credentials.json`
 *  and the global auth provider registry. */
export function buildSpawnCredentialBroker(): CredentialBroker {
  return new CredentialBroker({
    store: new CredentialsJsonStore(),
    getProvider: getAuthProvider,
  })
}

/** Resolve header-injected MCP server entries into local proxy URLs.
 *
 *  Entries without `credentialPath` pass through unchanged. Entries with
 *  `credentialPath` get a local reverse proxy whose upstream connection carries
 *  the broker-resolved auth headers. The returned `close` function tears down
 *  all proxies created by this call. */
export async function resolveMcpServersWithSecrets(opts: {
  entries: SpawnMcpServerEntry[]
  broker: McpHeaderResolver
  signal?: AbortSignal
}): Promise<{ entries: AcpMcpServer[]; close: () => Promise<void> }> {
  const proxies: AuthedMcpProxy[] = []
  const out: AcpMcpServer[] = []

  async function closeAll(): Promise<void> {
    await Promise.all(proxies.map(p => p.close().catch(() => {})))
  }

  try {
    for (const entry of opts.entries) {
      if (!entry.credentialPath) {
        out.push(entry)
        continue
      }

      if (entry.transport !== "http" && entry.transport !== "sse") {
        throw new Error(
          `mcpServers entry "${entry.name}" has credentialPath but transport "${entry.transport}" does not support header injection`,
        )
      }

      if (!entry.ref) {
        throw new Error(
          `mcpServers entry "${entry.name}" has credentialPath but no ref (upstream URL)`,
        )
      }

      const exposure: McpHeaderExposure = {
        kind: "mcp-header",
        credentialPath: entry.credentialPath,
        server: entry.ref,
      }
      const headers = await resolveMcpHeaderExposure(exposure, opts.broker, {
        signal: opts.signal,
      })
      const proxy = await createAuthedMcpProxy({
        upstreamUrl: entry.ref,
        headers,
      })
      proxies.push(proxy)
      out.push({
        name: entry.name,
        transport: entry.transport,
        ref: proxy.url,
      })
    }

    return { entries: out, close: closeAll }
  } catch (err) {
    await closeAll()
    throw err
  }
}

/** Resolve both env exposures and MCP-header proxy entries for a spawn.
 *
 *  Returns the scoped env map, the rewritten `mcpServers` array (safe to
 *  forward to a child), and a `closeProxies` callback to tear down any proxies
 *  created for this spawn. */
export async function resolveSpawnExposures(opts: {
  exposures?: SecretExposure[]
  mcpServers?: SpawnMcpServerEntry[]
  broker: McpHeaderResolver
  resolveEnvValue?: ResolveEnvValue
  signal?: AbortSignal
}): Promise<{
  env: Record<string, string>
  mcpServers: AcpMcpServer[]
  closeProxies: () => Promise<void>
}> {
  const env: Record<string, string> = {}

  if (opts.exposures) {
    for (const exposure of opts.exposures) {
      if (isExposureKind(exposure, "env")) {
        const resolved = await resolveEnvExposure(exposure, opts.resolveEnvValue)
        env[resolved.name] = resolved.value
      }
    }
  }

  const mcpResult = await resolveMcpServersWithSecrets({
    entries: opts.mcpServers ?? [],
    broker: opts.broker,
    signal: opts.signal,
  })

  return {
    env,
    mcpServers: mcpResult.entries,
    closeProxies: mcpResult.close,
  }
}
