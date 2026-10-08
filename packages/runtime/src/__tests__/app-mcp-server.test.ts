import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent as HttpAgent, request as httpRequest } from "node:http"
import matter from "gray-matter"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { defineApp } from "@agentproto/app-kit"
import { loadPublishedApp, startAppMcpHttp } from "../app-mcp-server.js"

async function writeBundled(dir: string, kind: "tools" | "drivers", id: string, file: string, data: Record<string, unknown>) {
  const target = join(dir, ".agentproto", kind, id, file)
  await mkdir(join(target, ".."), { recursive: true })
  await writeFile(target, matter.stringify("", data), "utf8")
}

async function buildCatalogApp(dir: string, uiTools: string[]) {
  await defineApp({
    id: "@test/catalog",
    name: "Catalog",
    ui: { html: "<html>catalog</html>", title: "Catalog", tools: uiTools },
  }).emit(dir)
  await writeBundled(dir, "tools", "greet", "TOOL.md", {
    schema: "agentproto/tool/v1",
    id: "greet",
    name: "Greet",
    description: "Greets a name.",
    version: "1.0.0",
    inputs: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    outputs: { type: "object", required: ["greeting"], properties: { greeting: { type: "string" } } },
  })
  await writeBundled(dir, "drivers", "greet-cli", "DRIVER.md", {
    schema: "agentproto/driver/v1",
    id: "greet-cli",
    name: "Greet CLI Driver",
    description: "Greets via node -e.",
    version: "1.0.0",
    kind: "cli",
    implements: [
      {
        tool: "greet",
        version: "*",
        metadata: {
          cli: {
            argv: ["-e", "console.log(JSON.stringify({greeting: 'hello, ' + process.argv[1]}))", "${input.name}"],
            outputFormat: "json",
          },
        },
      },
    ],
    metadata: { cli: { bin: process.execPath } },
  })
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  return content?.find(c => c.type === "text")?.text ?? ""
}

describe("app-mcp-server: publish one app as a standalone MCP App", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-mcp-server-test-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("serves the bundled tool linked to the ui:// resource, and the resource itself", async () => {
    await buildCatalogApp(dir, ["greet"])
    const app = await loadPublishedApp(dir)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await app.build().connect(serverT)
    const client = new Client({ name: "t", version: "0" })
    await client.connect(clientT)

    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual(["greet"])
    expect((tools[0]?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe(app.resourceUri)

    const read = await client.readResource({ uri: app.resourceUri })
    const first = read.contents[0] as { mimeType?: string; text?: string }
    expect(first.mimeType).toBe("text/html;profile=mcp-app")
    expect(first.text).toBe("<html>catalog</html>")

    const res = await client.callTool({ name: "greet", arguments: { name: "World" } })
    expect(JSON.parse(textOf(res))).toEqual({ greeting: "hello, World" })
  })

  it("refuses a ui.tools id that is not a bundled tool", async () => {
    await buildCatalogApp(dir, ["greet", "known_tool"])
    await expect(loadPublishedApp(dir)).rejects.toThrow(/not bundled/)
  })

  it("multi-tenant HTTP: known tenant answers, unknown tenant is 404", async () => {
    await buildCatalogApp(dir, ["greet"])
    const app = await loadPublishedApp(dir)
    const http = await startAppMcpHttp({ app, tenants: { "shop-a": {} } })
    try {
      const client = new Client({ name: "t", version: "0" })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp/shop-a`)))
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["greet"])
      await client.close()

      const unknown = await fetch(`${http.url}/mcp/nope`, { method: "POST" })
      expect(unknown.status).toBe(404)
    } finally {
      await http.close()
    }
  })

  it("answers 404 for a wrong path and 405 for a non-POST method", async () => {
    await buildCatalogApp(dir, ["greet"])
    const app = await loadPublishedApp(dir)
    const single = await startAppMcpHttp({ app })
    const multi = await startAppMcpHttp({ app, tenants: { "shop-a": {} } })
    try {
      expect((await fetch(`${single.url}/elsewhere`, { method: "POST" })).status).toBe(404)
      const get = await fetch(`${single.url}/mcp`, { method: "GET" })
      expect(get.status).toBe(405)
      expect(get.headers.get("allow")).toBe("POST")
      expect((await fetch(`${multi.url}/mcp`, { method: "POST" })).status).toBe(404)
      expect((await fetch(`${multi.url}/mcp/shop-a`, { method: "DELETE" })).status).toBe(405)
    } finally {
      await single.close()
      await multi.close()
    }
  })

  it("rejects a foreign Host or Origin on a loopback bind (DNS rebinding) and accepts loopback", async () => {
    await buildCatalogApp(dir, ["greet"])
    const app = await loadPublishedApp(dir)
    const http = await startAppMcpHttp({ app })
    const url = new URL(http.url)
    const post = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: url.port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } },
          res => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on("error", reject)
        req.end("{}")
      })
    try {
      expect(await post({ host: "evil.example.com" })).toBe(403)
      expect(await post({ host: `127.0.0.1:${url.port}`, origin: "http://evil.example.com" })).toBe(403)
      expect(await post({ host: `localhost:${url.port}`, origin: "null" })).toBe(403)
      expect(await post({ host: `127.0.0.1:${url.port}` })).not.toBe(403)
      expect(await post({ host: `localhost:${url.port}`, origin: `http://localhost:${url.port}` })).not.toBe(403)
    } finally {
      await http.close()
    }
  })

  it("caps the request body (413) and rejects invalid JSON (400)", async () => {
    await buildCatalogApp(dir, ["greet"])
    const app = await loadPublishedApp(dir)
    const http = await startAppMcpHttp({ app, maxBodyBytes: 64 })
    try {
      const big = await fetch(`${http.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(200) }),
      })
      expect(big.status).toBe(413)
      const bad = await fetch(`${http.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      })
      expect(bad.status).toBe(400)
    } finally {
      await http.close()
    }
  })

  it("close() resolves even with an open keep-alive connection", async () => {
    await buildCatalogApp(dir, ["greet"])
    const app = await loadPublishedApp(dir)
    const http = await startAppMcpHttp({ app })
    const agent = new HttpAgent({ keepAlive: true })
    const url = new URL(http.url)
    await new Promise<void>((resolve, reject) => {
      httpRequest({ host: "127.0.0.1", port: url.port, path: "/nope", method: "POST", agent }, res => {
        res.resume()
        res.on("end", resolve)
      })
        .on("error", reject)
        .end()
    })
    await expect(http.close()).resolves.toBeUndefined()
    agent.destroy()
  })
})
