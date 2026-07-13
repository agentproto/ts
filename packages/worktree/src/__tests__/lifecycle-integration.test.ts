import { describe, it, expect, afterEach } from "vitest"
import http from "node:http"
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTool } from "@agentproto/driver"
import {
  provisionWorktreeTool,
  cleanupWorktreeTool,
  startServiceTool,
  listServicesTool,
  stopServiceTool,
} from "../tools/index.js"
import { worktreeProvider } from "../provider/worktree-provider.js"
import { startProxy, type RunningProxy } from "../services/proxy-server.js"
import { sharedProxyTable, ephemeralPort } from "../services/index.js"
import { execGit } from "../exec.js"

const candidates = [worktreeProvider]

/** A tiny service that echoes its own + peer discovery env as JSON. */
const SERVER_JS = `const http = require("node:http")
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({
    url: process.env.AGENTPROTO_URL,
    port: process.env.AGENTPROTO_PORT,
    branch: process.env.AGENTPROTO_BRANCH_NAME,
    webPort: process.env.AGENTPROTO_SERVICE_WEB_PORT,
    apiPort: process.env.AGENTPROTO_SERVICE_API_PORT,
    webUrl: process.env.AGENTPROTO_SERVICE_WEB_URL,
    apiUrl: process.env.AGENTPROTO_SERVICE_API_URL,
  }))
}).listen(Number(process.env.AGENTPROTO_PORT), "127.0.0.1")
`

const CONFIG = JSON.stringify({
  worktree: {
    setup: [
      'node -e "require(\'fs\').writeFileSync(\'setup-ran.txt\', process.env.AGENTPROTO_BRANCH_NAME)"',
    ],
    teardown:
      'node -e "require(\'fs\').writeFileSync(process.env.AGENTPROTO_SOURCE_CHECKOUT_PATH + \'/teardown-ran.txt\', \'ok\')"',
  },
  scripts: {
    web: { command: "node server.js", type: "service" },
    api: { command: "node server.js", type: "service" },
  },
})

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "wt-life-"))
  await execGit(repo, ["init", "-b", "main"])
  await execGit(repo, ["config", "user.email", "t@e.com"])
  await execGit(repo, ["config", "user.name", "T"])
  await writeFile(join(repo, "agentproto.json"), CONFIG)
  await writeFile(join(repo, "server.js"), SERVER_JS)
  await execGit(repo, ["add", "agentproto.json", "server.js"])
  await execGit(repo, ["commit", "-m", "init"])
  return repo
}

function getJson(port: number, host: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
      let body = ""
      res.on("data", (d) => (body += d))
      res.on("end", () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(new Error(`bad JSON (status ${res.statusCode}): ${body} — ${String(err)}`))
        }
      })
    })
    req.on("error", reject)
    req.end()
  })
}

async function pollJson(port: number, host: string): Promise<Record<string, string>> {
  let lastErr: unknown
  for (let i = 0; i < 100; i++) {
    try {
      return await getJson(port, host)
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  throw new Error(`service never came up on ${host}: ${String(lastErr)}`)
}

describe("worktree lifecycle end-to-end (real git + services + proxy)", () => {
  const cleanupPaths: string[] = []
  let proxy: RunningProxy | undefined

  afterEach(async () => {
    if (proxy) await proxy.close()
    proxy = undefined
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("provisions (setup ran) → two services w/ peer env → proxy routes → cleanup (teardown ran)", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)

    // Reverse proxy over the shared routing table, on a known port so the
    // services' AGENTPROTO_URL matches where the proxy actually listens.
    const proxyPort = await ephemeralPort()
    proxy = await startProxy(sharedProxyTable, proxyPort)

    // 1. Provision — setup hook runs in the worktree with branch env.
    const provisioned = await runTool({
      tool: provisionWorktreeTool,
      candidates,
      input: { repoRoot: repo, base: "main", slug: "svc-test" },
    })
    cleanupPaths.push(provisioned.cwd)
    expect(provisioned.branch).toBe("wt/svc-test")
    const setupMarker = await readFile(join(provisioned.cwd, "setup-ran.txt"), "utf8")
    expect(setupMarker).toBe("wt/svc-test")

    // 2. Start both services.
    const web = await runTool({
      tool: startServiceTool,
      candidates,
      input: { repoRoot: repo, worktreePath: provisioned.cwd, branch: provisioned.branch, script: "web", base: "main", proxyPort },
    })
    const api = await runTool({
      tool: startServiceTool,
      candidates,
      input: { repoRoot: repo, worktreePath: provisioned.cwd, branch: provisioned.branch, script: "api", base: "main", proxyPort },
    })
    expect(web.status).toBe("running")
    expect(api.status).toBe("running")
    expect(web.hostname).toBe("web--wt-svc-test--" + repoBasename(repo) + ".localhost")
    expect(web.url).toBe(`http://${web.hostname}:${proxyPort}`)

    try {
      // 3 + 4. Proxy routes to the right service, and each sees its peer.
      const fromWeb = await pollJson(proxyPort, web.hostname)
      expect(fromWeb.port).toBe(String(web.port))
      expect(fromWeb.url).toBe(web.url)
      // Peer discovery: web sees api's port + URL (ports were reserved up front).
      expect(fromWeb.apiPort).toBe(String(api.port))
      expect(fromWeb.apiUrl).toBe(api.url)

      const fromApi = await pollJson(proxyPort, api.hostname)
      expect(fromApi.port).toBe(String(api.port))
      expect(fromApi.webPort).toBe(String(web.port))

      // list-services reports both running.
      const listed = await runTool({
        tool: listServicesTool,
        candidates,
        input: { repoRoot: repo, worktreePath: provisioned.cwd, branch: provisioned.branch, base: "main", proxyPort },
      })
      expect(listed.services.map((s) => s.name).sort()).toEqual(["api", "web"])
      expect(listed.services.every((s) => s.status === "running")).toBe(true)

      // stop-service drops the route.
      const stopped = await runTool({
        tool: stopServiceTool,
        candidates,
        input: { worktreePath: provisioned.cwd, script: "web" },
      })
      expect(stopped.stopped).toBe(true)
      expect(sharedProxyTable.get(web.hostname)).toBeUndefined()
    } finally {
      // 5. Cleanup — teardown hook runs, worktree removed, services stopped.
      const cleaned = await runTool({
        tool: cleanupWorktreeTool,
        candidates,
        input: { repoRoot: repo, cwd: provisioned.cwd, branch: provisioned.branch, base: "main", deleteBranch: true },
      })
      expect(cleaned).toEqual({ removed: true })
    }

    const teardownMarker = await readFile(join(repo, "teardown-ran.txt"), "utf8")
    expect(teardownMarker).toBe("ok")
    // Worktree directory is gone.
    await expect(access(provisioned.cwd)).rejects.toBeDefined()
    // api's route was dropped on cleanup too.
    expect(sharedProxyTable.get(api.hostname)).toBeUndefined()
  })
})

function repoBasename(repo: string): string {
  const parts = repo.replace(/[/\\]+$/, "").split(/[/\\]/)
  return (parts[parts.length - 1] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}
