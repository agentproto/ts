/**
 * Browser-safety check for `@agentproto/pair-client`, the same check as the
 * `@agentproto/acp/tunnel/browser` and `@agentproto/secrets/pairing/browser`
 * entries:
 *
 *   1. Static: bundle `src/index.ts` with esbuild for `platform: "browser"`;
 *      any Node builtin reachable from it fails the test, naming the importer.
 *      The harness (which uses `node:fs`, `ws`) must be flagged — so the check
 *      has teeth.
 *   2. Runtime: evaluate the bundle in a fresh VM context holding only web
 *      globals — no `Buffer`, `process` or `require` — and, from inside it,
 *      pair with the real Node daemon through a real rendezvous and fetch
 *      through the tunnel (buffered and streamed).
 */

import { describe, it, expect, afterEach } from "vitest"
import { builtinModules } from "node:module"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { build, type Plugin } from "esbuild"
import { startDaemon, type Daemon } from "./harness.js"

const BUILTINS = new Set(builtinModules.map(m => m.replace(/^node:/, "")))

function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return true
  return BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]!)
}

async function bundleForBrowser(entry: string): Promise<{ code: string; offenders: string[] }> {
  const offenders: string[] = []
  const forbidNode: Plugin = {
    name: "forbid-node-builtins",
    setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (!isNodeBuiltin(args.path)) return undefined
        offenders.push(`${args.path} ← ${args.importer}`)
        return { path: args.path, external: true }
      })
    },
  }
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "__entry",
    target: "es2022",
    write: false,
    logLevel: "silent",
    plugins: [forbidNode],
  })
  return { code: result.outputFiles[0]!.text, offenders }
}

const entry = fileURLToPath(new URL("../index.ts", import.meta.url))
const harness = fileURLToPath(new URL("./harness.ts", import.meta.url))

let daemon: Daemon | null = null
afterEach(async () => {
  await daemon?.teardown()
  daemon = null
})

describe("@agentproto/pair-client is browser-safe", () => {
  it("reaches no Node builtin (and the check does catch one in the Node harness)", async () => {
    const browser = await bundleForBrowser(entry)
    expect(browser.offenders).toEqual([])

    const node = await bundleForBrowser(harness).catch(() => ({ offenders: ["unbundleable"] }))
    expect(node.offenders.length).toBeGreaterThan(0)
  }, 30_000)

  it("pairs and fetches from a realm with only web globals", async () => {
    const { code } = await bundleForBrowser(entry)
    daemon = await startDaemon({ label: "vm-daemon" })
    const offerUrl = await daemon.offer()

    const ctx = vm.createContext({
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      WebSocket: globalThis.WebSocket,
      Request,
      Response,
      Headers,
      ReadableStream,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      console,
    })
    vm.runInContext(code, ctx)
    expect(vm.runInContext("typeof Buffer + typeof process + typeof require", ctx)).toBe(
      "undefinedundefinedundefined",
    )

    ctx.__offer = offerUrl
    const out = (await vm.runInContext(
      `(async () => {
        const t = __entry
        const store = t.createMemoryCredentialStore()
        const web = t.encodeOfferWebUrl(__offer)
        const pending = await t.pairFromOffer(web, { store, clientName: "vm" })
        const cred = await pending.confirm()
        const client = t.connect(cred, { reconnectMinMs: 50 })
        await client.ready()
        const json = await (await client.fetch("/hello", { method: "POST", body: "hi" })).json()
        const res = await client.fetch("/sse")
        const reader = res.body.getReader()
        const first = new TextDecoder().decode((await reader.read()).value)
        await reader.cancel()
        client.close()
        return {
          name: pending.daemon.name,
          stored: (await store.list()).length,
          extractable: cred.pairRoot.extractable,
          json,
          first,
          state: client.state,
        }
      })()`,
      ctx,
    )) as Record<string, unknown>

    expect(out).toMatchObject({
      name: "vm-daemon",
      stored: 1,
      extractable: false,
      json: { method: "POST", path: "/hello", body: "hi" },
      first: "event: tick\ndata: 1\n\n",
      state: "closed",
    })
  }, 30_000)
})
