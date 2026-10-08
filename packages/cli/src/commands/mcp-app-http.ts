/**
 * `agentproto mcp-app --http <appDir> [--port N] [--host H] [--tenants <file.json>]`
 *
 * Serve ONE app (its own bundled tools + its UI) as a standalone MCP App over
 * streamable HTTP, with no daemon behind it. Single-tenant: `/mcp`, secrets
 * read from env vars named in the app's `requirements.secrets`. Multi-tenant
 * (`--tenants`): a JSON file `{ "<tenant>": { "<SECRET>": "<value>" } }`,
 * served at `/mcp/<tenant>`.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { loadPublishedApp, startAppMcpHttp } from "@agentproto/runtime/app-mcp-server"

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

export async function runMcpAppHttp(args: readonly string[]): Promise<number> {
  const valued = new Set(["--port", "--host", "--tenants"])
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""))
  const dirArg = positional[0]
  if (!dirArg) {
    process.stderr.write("usage: agentproto mcp-app --http <appDir> [--port N] [--host H] [--tenants <file.json>]\n")
    return 2
  }
  const app = await loadPublishedApp(resolve(dirArg))
  const portArg = flag(args, "--port")
  const hostArg = flag(args, "--host")
  const tenantsPath = flag(args, "--tenants")

  let tenants: Record<string, Record<string, string>> | undefined
  let secrets: Record<string, string> | undefined
  if (tenantsPath) {
    tenants = JSON.parse(await readFile(resolve(tenantsPath), "utf8")) as Record<string, Record<string, string>>
  } else {
    secrets = {}
    for (const name of app.secretNames) {
      const value = process.env[name]
      if (value !== undefined) secrets[name] = value
    }
  }

  const http = await startAppMcpHttp({
    app,
    ...(portArg !== undefined ? { port: Number(portArg) } : {}),
    ...(hostArg !== undefined ? { host: hostArg } : {}),
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
