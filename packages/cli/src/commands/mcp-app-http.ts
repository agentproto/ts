/**
 * `agentproto mcp-app --http <appDir> [--port N] [--host H] [--tenants <file.json>]`
 *
 * Serve ONE app (its own bundled tools + its UI) as a standalone MCP App over
 * streamable HTTP, with no daemon behind it. Single-tenant: `/mcp`, secrets
 * read from env vars named in the app's `requirements.secrets`. Multi-tenant
 * (`--tenants`): a JSON file `{ "<tenant>": { "<SECRET>": "<value>" } }`,
 * served at `/mcp/<tenant>`.
 *
 * There is NO built-in authentication: the tenant slug only selects which
 * secrets apply and is not a credential. Anything beyond loopback needs a
 * front proxy that terminates TLS and authenticates callers.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { isValidTenantSlug, loadPublishedApp, startAppMcpHttp } from "@agentproto/runtime/app-mcp-server"

const USAGE = "usage: agentproto mcp-app --http <appDir> [--port N] [--host H] [--tenants <file.json>]"

export interface McpAppHttpArgs {
  dir: string
  port?: number
  host?: string
  tenantsPath?: string
}

/** Strict argv parsing: every flag needs a value, unknown flags and extra positionals are rejected. */
export function parseMcpAppHttpArgs(args: readonly string[]): McpAppHttpArgs {
  const out: { dir?: string; port?: number; host?: string; tenantsPath?: string } = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--port" || a === "--host" || a === "--tenants") {
      const value = args[i + 1]
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} requires a value`)
      i++
      if (a === "--port") {
        const port = Number(value)
        if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`--port must be an integer between 1 and 65535 (got '${value}')`)
        }
        out.port = port
      } else if (a === "--host") out.host = value
      else out.tenantsPath = value
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag ${a}`)
    } else if (out.dir === undefined) {
      out.dir = a
    } else {
      throw new Error(`unexpected extra argument '${a}'`)
    }
  }
  if (out.dir === undefined) throw new Error("missing <appDir>")
  return out as McpAppHttpArgs
}

/**
 * Validate the parsed `--tenants` JSON: `{ "<slug>": { "<SECRET>": "<string>" } }`,
 * slugs routable (`isValidTenantSlug`), secret names limited to the app's
 * declared `requirements.secrets` (a typo'd name would otherwise silently
 * never reach the driver). Missing declared secrets are returned as warnings.
 */
export function validateTenants(
  raw: unknown,
  secretNames: readonly string[],
): { tenants: Record<string, Record<string, string>>; warnings: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("tenants file must be a JSON object of { <tenant>: { <SECRET>: <value> } }")
  }
  const declared = new Set(secretNames)
  const tenants: Record<string, Record<string, string>> = {}
  const warnings: string[] = []
  for (const [slug, value] of Object.entries(raw)) {
    if (!isValidTenantSlug(slug)) {
      throw new Error(`tenant slug '${slug}' is invalid (lowercase letters, digits and '-', max 63 chars, must start with a letter or digit)`)
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`tenant '${slug}' must be an object of { <SECRET>: <string> }`)
    }
    const secrets: Record<string, string> = {}
    for (const [name, secret] of Object.entries(value)) {
      if (typeof secret !== "string") throw new Error(`tenant '${slug}': secret '${name}' must be a string`)
      if (!declared.has(name)) {
        throw new Error(`tenant '${slug}': secret '${name}' is not declared in the app's requirements.secrets (${secretNames.join(", ") || "none"})`)
      }
      secrets[name] = secret
    }
    for (const name of secretNames) {
      if (!(name in secrets)) warnings.push(`tenant '${slug}': declared secret '${name}' is not set`)
    }
    tenants[slug] = secrets
  }
  return { tenants, warnings }
}

export async function runMcpAppHttp(args: readonly string[]): Promise<number> {
  let parsed: McpAppHttpArgs
  try {
    parsed = parseMcpAppHttpArgs(args)
  } catch (err) {
    process.stderr.write(`agentproto mcp-app: ${(err as Error).message}\n${USAGE}\n`)
    return 2
  }
  const app = await loadPublishedApp(resolve(parsed.dir))

  let tenants: Record<string, Record<string, string>> | undefined
  let secrets: Record<string, string> | undefined
  const warnings: string[] = []
  if (parsed.tenantsPath) {
    try {
      const checked = validateTenants(JSON.parse(await readFile(resolve(parsed.tenantsPath), "utf8")), app.secretNames)
      tenants = checked.tenants
      warnings.push(...checked.warnings)
    } catch (err) {
      process.stderr.write(`agentproto mcp-app: ${parsed.tenantsPath}: ${(err as Error).message}\n`)
      return 2
    }
  } else {
    secrets = {}
    for (const name of app.secretNames) {
      const value = process.env[name]
      if (value !== undefined) secrets[name] = value
      else warnings.push(`declared secret '${name}' is not set in the environment`)
    }
  }
  for (const w of warnings) process.stderr.write(`agentproto mcp-app: warning: ${w}\n`)

  const http = await startAppMcpHttp({
    app,
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
    ...(parsed.host !== undefined ? { host: parsed.host } : {}),
    ...(tenants ? { tenants } : { secrets }),
  })
  const endpoints = tenants ? Object.keys(tenants).map(t => `${http.url}/mcp/${t}`) : [`${http.url}/mcp`]
  process.stderr.write(
    `agentproto mcp-app: serving "${app.appId}" (${app.toolIds.join(", ")})\n` +
      endpoints.map(e => `  ${e}\n`).join(""),
  )

  await new Promise<void>(done => {
    const stop = () => {
      void http.close().then(done)
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  return 0
}
