/**
 * `app_tunnel` — the daemon-side realization of "the daemon creates the
 * tunnel for an app" (AIP-standardization Phase 2, Telegram miniapp surface).
 *
 * Given an installed app directory (or an explicit `targetPort`), create a
 * public tunnel for its `ui.port` through the same {@link TunnelRegistry} the
 * `tunnel_create` tool drives, then optionally hand back the miniapp session
 * deep link for it.
 *
 * Provider selection:
 *   - default → `quick` (Cloudflare Quick Tunnel) with the private access
 *     guard (the returned `url` is the signed link, not the bare host);
 *   - `hostname` set → `cloudflare-named`, a STABLE hostname. The `tunnelId` /
 *     `credentialsFile` are resolved from the daemon's own registered creds
 *     (`~/.agentproto/tunnel-creds/cloudflare-named.json`, written by
 *     `setup_tunnel_provider`) — the daemon holds the secrets; the caller
 *     passes only the hostname.
 *
 * Never reads a secret from the environment or echoes one back.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { resolve } from "node:path"
import { z } from "zod"

import { loadAppHandle } from "@agentproto/app-kit"

import type { TunnelDescriptor, TunnelRegistry } from "./tunnel-registry.js"
import { makeTunnelCredsStore } from "./tunnel-adapters.js"
import { CLOUDFLARE_NAMED_SLUG } from "./remote-providers/named.js"
import { normalizeProviderSlug } from "./remote-providers/registry.js"
import { buildSessionLink } from "./tunnel-links.js"

export interface RegisterAppTunnelToolsOptions {
  registry: TunnelRegistry
  /**
   * Creds reader for `cloudflare-named`. Defaults to the daemon's own tunnel
   * creds store (`~/.agentproto/tunnel-creds/`); injectable for tests.
   */
  readCreds?: (slug: string) => Promise<Record<string, string> | null>
  /** Manifest loader seam (tests). Defaults to app-kit's `loadAppHandle`. */
  loadHandle?: (dir: string) => Promise<{ ui?: { port?: number } }>
}

function text(value: string | object): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  }
}

function errText(
  toolName: string,
  err: unknown,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [
      {
        type: "text",
        text: `${toolName}: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  }
}

const appTunnelSchema = z.object({
  dir: z
    .string()
    .optional()
    .describe(
      "App directory (holding `.agentproto/APP.md`). Its `ui.port` is used as " +
        "the tunnel target; required unless `targetPort` is given.",
    ),
  targetPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("Local port to expose. Overrides (and obviates) `dir`."),
  session: z
    .string()
    .optional()
    .describe(
      "Session id to build the miniapp deep link for. When set, the result " +
        "carries `sessionLink` = `<url>/s/<sessionId>`.",
    ),
  hostname: z
    .string()
    .optional()
    .describe(
      "Stable public hostname (e.g. app.example.com). When set, the tunnel is " +
        "created with the `cloudflare-named` provider using the daemon's " +
        "already-registered creds.",
    ),
  name: z
    .string()
    .optional()
    .describe("Optional friendly tunnel name slug (accepted as id-or-name later)."),
  provider: z
    .string()
    .optional()
    .describe("Explicit provider slug. Defaults to `quick`, or `cloudflare-named` when `hostname` is set."),
  label: z.string().optional().describe("Free-text label for `tunnel_list`."),
  ttl: z.string().optional().describe('Signed-link TTL ("1h" | "24h" | "7d"). Ignored when `public:true`.'),
  public: z
    .boolean()
    .optional()
    .describe("Opt out of the access guard. Only for content that is genuinely public."),
})
type AppTunnelInput = z.infer<typeof appTunnelSchema>

export interface AppTunnelResult {
  tunnelId: string
  url: string
  provider: string
  targetPort: number
  name?: string
  hostname?: string
  sessionLink?: string
}

export function registerAppTunnelTools(
  server: McpServer,
  opts: RegisterAppTunnelToolsOptions,
): void {
  const { registry } = opts
  const readCreds = opts.readCreds ?? (slug => makeTunnelCredsStore().read(slug))
  const loadHandle = opts.loadHandle ?? (dir => loadAppHandle(dir))

  server.tool(
    "app_tunnel",
    "Create a public tunnel for an agentproto app's UI (its `ui.port`) and, " +
      "optionally, return the Telegram miniapp deep link for a session. " +
      "Loads the app manifest from `dir` (or takes an explicit `targetPort`), " +
      "creates the tunnel through the daemon's tunnel registry, and returns " +
      "`{ tunnelId, url, provider, targetPort, name?, hostname?, sessionLink? }`. " +
      "Private by default (the returned `url` is a signed link with a TTL). " +
      "With `hostname`, uses the `cloudflare-named` provider and the daemon's " +
      "already-registered named-tunnel creds — no secret is passed by the caller.",
    appTunnelSchema.shape,
    async (input: AppTunnelInput) => {
      try {
        const targetPort = await resolveTargetPort(input, loadHandle)
        const provider = input.provider ?? (input.hostname ? CLOUDFLARE_NAMED_SLUG : "quick")

        let tunnelId: string | undefined
        let credentialsFile: string | undefined
        if (normalizeProviderSlug(provider) === CLOUDFLARE_NAMED_SLUG) {
          const creds = await readCreds(CLOUDFLARE_NAMED_SLUG)
          tunnelId = typeof creds?.["tunnelId"] === "string" ? creds["tunnelId"] : undefined
          credentialsFile =
            typeof creds?.["credentialsFile"] === "string" ? creds["credentialsFile"] : undefined
          if (!tunnelId) {
            throw new Error(
              "cloudflare-named needs registered credentials (tunnelId) — none found. " +
                "Register them once with `setup_tunnel_provider cloudflare-named` " +
                "(hostname + tunnelId + optional credentialsFile).",
            )
          }
        }

        const desc = await registry.create({
          targetPort,
          provider,
          ...(input.name ? { name: input.name } : {}),
          ...(input.label ? { label: input.label } : {}),
          ...(input.hostname ? { hostname: input.hostname } : {}),
          ...(tunnelId ? { tunnelId } : {}),
          ...(credentialsFile ? { credentialsFile } : {}),
          ...(input.ttl ? { ttl: input.ttl } : {}),
          ...(input.public ? { public: true } : {}),
        })
        return text(toResult(desc, input.session))
      } catch (err) {
        return errText("app_tunnel", err)
      }
    },
  )
}

async function resolveTargetPort(
  input: AppTunnelInput,
  loadHandle: (dir: string) => Promise<{ ui?: { port?: number } }>,
): Promise<number> {
  if (input.targetPort !== undefined) return input.targetPort
  if (!input.dir) {
    throw new Error("pass `targetPort`, or a `dir` whose app declares `ui.port`")
  }
  const dir = resolve(input.dir)
  const handle = await loadHandle(dir)
  const port = handle.ui?.port
  if (port === undefined) {
    throw new Error(
      `app at ${dir} declares no 'ui.port' in its APP.md — the tunnel needs a port to expose`,
    )
  }
  return port
}

function toResult(desc: TunnelDescriptor, session?: string): AppTunnelResult {
  const url = desc.url ?? desc.publicUrl
  return {
    tunnelId: desc.id,
    url,
    provider: desc.provider,
    targetPort: desc.targetPort,
    ...(desc.name ? { name: desc.name } : {}),
    ...(desc.hostname ? { hostname: desc.hostname } : {}),
    ...(session ? { sessionLink: buildSessionLink(url, session) } : {}),
  }
}
