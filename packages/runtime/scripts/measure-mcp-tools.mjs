#!/usr/bin/env node
/**
 * Measure the daemon's `tools/list` response size — the full eager surface
 * and the deferred always-on set — and print per-tool bytes sorted desc plus
 * totals. Used to find the biggest tool descriptions to slim
 * (see `.plans/agentproto-onboarding/SLIM-MCP-TOOL-DESCRIPTIONS.md`) and to
 * report a before/after comparison in the PR body.
 *
 * Requires a build (`pnpm build`, or `pnpm --filter @agentproto/runtime build`)
 * — imports the compiled `dist/index.mjs`, not `src/`.
 *
 * Usage:
 *   node packages/runtime/scripts/measure-mcp-tools.mjs
 *   node packages/runtime/scripts/measure-mcp-tools.mjs --top 20
 */

import { createServer } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createGateway, measureToolList } from "../dist/index.mjs"

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolvePort(port))
    })
  })
}

async function listTools(deferredTools) {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-measure-mcp-tools-"))
  const gateway = await createGateway({
    workspace,
    specs: [],
    port: await freePort(),
    boot: false,
    persist: false,
    ...(deferredTools ? { deferredTools } : {}),
  })
  try {
    const client = new Client({ name: "measure-mcp-tools", version: "0.0.1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
    const { tools } = await client.listTools()
    await client.close()
    return tools
  } finally {
    await gateway.stop().catch(() => {})
    await rm(workspace, { recursive: true, force: true })
  }
}

function printReport(label, measurement, top) {
  console.log(`\n=== ${label} ===`)
  console.log(`${measurement.entries.length} tools, ${measurement.totalBytes.toLocaleString()} bytes total`)
  console.log(`\nTop ${Math.min(top, measurement.entries.length)} by size:`)
  for (const entry of measurement.entries.slice(0, top)) {
    console.log(`  ${entry.bytes.toString().padStart(7)}  ${entry.name}`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const topIdx = argv.indexOf("--top")
  const top = topIdx !== -1 ? Number(argv[topIdx + 1]) : 10

  const [fullSurface, alwaysOn] = await Promise.all([
    listTools(undefined),
    listTools({}),
  ])

  const fullMeasurement = measureToolList(fullSurface)
  const alwaysOnMeasurement = measureToolList(alwaysOn)

  printReport("full surface (deferredTools omitted)", fullMeasurement, top)
  printReport("deferred always-on set (deferredTools: {})", alwaysOnMeasurement, top)

  console.log("\n=== summary ===")
  console.log(`full surface:  ${fullMeasurement.entries.length} tools, ${fullMeasurement.totalBytes.toLocaleString()} bytes`)
  console.log(`always-on:     ${alwaysOnMeasurement.entries.length} tools, ${alwaysOnMeasurement.totalBytes.toLocaleString()} bytes`)
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
