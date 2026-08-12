/**
 * `agentproto app dev <appDir> [--port <n>] [--json] [-- <viteArgs...>]`
 *
 * Run an agentproto app's `ui/` **source** project (Vite + TypeScript)
 * through its own dev server, wired to a live `window.McpApp` bridge — the
 * "app serve" experience but with Vite's HMR instead of a static build.
 *
 * Two servers, two ports:
 *
 *   1. The `ui/`'s own dev server (`<pm> run dev`), spawned as a child with
 *      inherited stdio, on whatever port it picks.
 *
 *   2. A bridge-ONLY HTTP server this command owns directly — no static
 *      files, just `POST /__agentproto/tool-call` (the same route + wire
 *      contract `app serve` exposes, reusing its `callDaemonTool` /
 *      `handleToolCallRequest` / daemon-client machinery from
 *      `app-serve.ts`). Because the browser talks to the Vite dev origin
 *      (a *different* port than the bridge), this route needs real CORS
 *      headers — `app serve`'s equivalent route doesn't, since there the
 *      bridge and the static files are same-origin.
 *
 * The child gets `AGENTPROTO_BRIDGE_URL=http://127.0.0.1:<bridgePort>` so a
 * scaffolded `vite.config.ts` can proxy `/__agentproto` to it for
 * same-origin `fetch` calls from `connectMcpApp`'s default `bridgeRoute`;
 * direct cross-origin calls to the bridge URL also work via CORS.
 */

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { spawn } from "node:child_process"

import {
  TOOL_CALL_PATH,
  createDaemonMcpClientGetter,
  handleToolCallRequest,
  resolveDaemonMcpUrl,
} from "./app-serve.js"
import { pathExists } from "./commands/skill-install/shared.js"
import { expandHome } from "./commands/skill-install/pack-resolve.js"
import { detectPackageManager } from "./app-build.js"

const USAGE = `agentproto app dev — run an app's ui/ dev server with a live window.McpApp bridge

Usage:
  agentproto app dev <appDir> [--port <n>] [--json] [-- <viteArgs...>]

appDir:
  Directory holding <appDir>/ui/package.json with a "scripts.dev". A
  hand-written static UI (no ui/ dev script) has nothing to hot-reload —
  use "agentproto app serve" instead.

--port <n>:
  Port for the bridge-only HTTP server (POST /__agentproto/tool-call, CORS
  enabled). Defaults to an OS-assigned free port. This is NOT the Vite dev
  server's own port, which the ui/ project picks itself.

-- <viteArgs...>:
  Extra args forwarded verbatim to "<pm> run dev".

--json:
  Print {"bridgeUrl":"...","appDir":"..."} on a single line before handing
  the terminal to the dev server.`

/** Bind a bridge-only HTTP server (no static files) to `port` (0 = auto). */
export function bindBridgeServer(
  port: number,
  getClient: ReturnType<typeof createDaemonMcpClientGetter>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/"

    if (req.method === "OPTIONS" && urlPath === TOOL_CALL_PATH) {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "content-type")
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === "POST" && urlPath === TOOL_CALL_PATH) {
      handleToolCallRequest(req, res, getClient)
      return
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "not_found", path: urlPath }))
  })

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise)
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address()
      resolvePromise({
        port: addr && typeof addr === "object" ? addr.port : port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/** `agentproto app dev <appDir> [--port <n>] [--json] [-- <viteArgs...>]`. */
export async function runAppDev(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const appDirArg = positionals[0]
  if (!appDirArg) {
    process.stderr.write(`agentproto app dev: <appDir> is required.\n${USAGE}\n`)
    return 2
  }
  const appDir = resolve(process.cwd(), expandHome(appDirArg))
  const viteArgs = positionals.slice(1)
  const runJson = values.json === true

  // 1. Require a ui/ project with a dev script.
  const uiDir = join(appDir, "ui")
  const uiPkgPath = join(uiDir, "package.json")
  if (!(await pathExists(uiPkgPath))) {
    process.stderr.write(
      `agentproto app dev: ${uiPkgPath} not found — this app has no ui/ dev ` +
        `project. Static UIs run with: agentproto app serve\n`,
    )
    return 2
  }
  let hasDevScript = false
  try {
    const pkg: unknown = JSON.parse(await readFile(uiPkgPath, "utf8"))
    if (pkg && typeof pkg === "object") {
      const scripts = (pkg as Record<string, unknown>).scripts
      const dev = scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>).dev : undefined
      hasDevScript = typeof dev === "string" && dev.length > 0
    }
  } catch {
    hasDevScript = false
  }
  if (!hasDevScript) {
    process.stderr.write(
      `agentproto app dev: ${uiPkgPath} has no "scripts.dev" — this app has ` +
        `no ui/ dev project. Static UIs run with: agentproto app serve\n`,
    )
    return 2
  }

  let explicitPort: number | undefined
  if (typeof values.port === "string" && values.port.length > 0) {
    const p = Number(values.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      process.stderr.write(
        `agentproto app dev: invalid --port '${values.port}' (must be 1–65535).\n`,
      )
      return 2
    }
    explicitPort = p
  }

  // 2. The bridge server — its own daemon MCP client, same pattern as `app serve`.
  const daemonMcpUrl = await resolveDaemonMcpUrl()
  const getClient = createDaemonMcpClientGetter(daemonMcpUrl, "agentproto-app-dev")
  const bridge = await bindBridgeServer(explicitPort ?? 0, getClient)
  const bridgeUrl = `http://127.0.0.1:${bridge.port}`

  if (runJson) {
    process.stdout.write(JSON.stringify({ bridgeUrl, appDir }) + "\n")
  } else {
    process.stdout.write(
      `agentproto app dev: bridge -> ${bridgeUrl}${TOOL_CALL_PATH} (daemon /mcp -> ${daemonMcpUrl})\n`,
    )
  }

  // 3. Spawn the ui/ project's own dev server.
  const pm = await detectPackageManager(appDir, uiDir)
  const devArgs = viteArgs.length > 0 ? ["run", "dev", "--", ...viteArgs] : ["run", "dev"]
  const child = spawn(pm, devArgs, {
    cwd: uiDir,
    stdio: "inherit",
    env: { ...process.env, AGENTPROTO_BRIDGE_URL: bridgeUrl },
  })

  let torndown = false
  const teardown = async (): Promise<void> => {
    if (torndown) return
    torndown = true
    await bridge.close()
  }

  const exitCode = await new Promise<number>((resolvePromise) => {
    const onSigint = () => {
      try {
        child.kill("SIGINT")
      } catch {
        /* ignore */
      }
    }
    process.once("SIGINT", onSigint)
    process.once("SIGTERM", onSigint)
    child.once("exit", (code) => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigint)
      resolvePromise(code ?? 0)
    })
    child.once("error", () => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigint)
      resolvePromise(1)
    })
  })

  await teardown()
  return exitCode
}
