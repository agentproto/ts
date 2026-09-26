/**
 * Browser-safety check for `@agentproto/acp/tunnel/browser`.
 *
 *   1. Static: bundle the entry with esbuild for `platform: "browser"`; any
 *      import of a Node builtin (`node:*` or a bare builtin name) anywhere in
 *      the reachable graph fails the test, with the importing file named. The
 *      same check run on the Node entry must flag it — so the check has teeth.
 *   2. Runtime: evaluate the bundle in a fresh VM context that has only web
 *      globals — no `Buffer`, no `process`, no `require` — and exchange E2E
 *      frames between it (WebCrypto) and a `node:crypto` `wrapE2E` in this
 *      realm, both ways.
 */

import { describe, it, expect, vi } from "vitest"
import { builtinModules } from "node:module"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { build, type Plugin } from "esbuild"
import { wrapE2E, type FrameSink, type TunnelFrame } from "../tunnel/index.js"

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

const browserEntry = fileURLToPath(new URL("../tunnel/browser.ts", import.meta.url))
const nodeEntry = fileURLToPath(new URL("../tunnel/index.ts", import.meta.url))

describe("@agentproto/acp/tunnel/browser is browser-safe", () => {
  it("reaches no Node builtin (and the check does catch one in the Node entry)", async () => {
    const browser = await bundleForBrowser(browserEntry)
    expect(browser.offenders).toEqual([])

    const node = await bundleForBrowser(nodeEntry)
    expect(node.offenders.length).toBeGreaterThan(0)
  }, 30_000)

  it("exchanges E2E frames between a Buffer-less realm (WebCrypto) and node:crypto", async () => {
    const { code } = await bundleForBrowser(browserEntry)
    // Frames cross the realm boundary as JSON text, like on a real socket.
    const toHost: string[] = []
    const ctx = vm.createContext({
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      console,
      __toHost: (text: string) => toHost.push(text),
    })
    vm.runInContext(code, ctx)
    expect(vm.runInContext("typeof Buffer + typeof process + typeof require", ctx)).toBe(
      "undefinedundefinedundefined",
    )

    const sendKey = new Uint8Array(32).fill(7)
    const recvKey = new Uint8Array(32).fill(9)

    // Browser side: a sink whose wire is JSON text handed to the host.
    vm.runInContext(
      `(() => {
        const t = __entry
        const handlers = new Set()
        const sink = {
          isOpen: true,
          send: f => __toHost(t.encodeFrame(f)),
          close() {},
          onFrame: h => (handlers.add(h), () => handlers.delete(h)),
          onClose: () => () => {},
        }
        globalThis.__fromHost = text => { const f = t.parseFrame(text); for (const h of handlers) h(f) }
        const keys = { sendKey: new Uint8Array(32).fill(7), recvKey: new Uint8Array(32).fill(9) }
        const w = t.wrapE2E(sink, keys)
        globalThis.__got = []
        w.onFrame(f => __got.push(f.t === "stdout" ? t.decodeData(f.data).length : f.t))
        for (let i = 0; i < 20; i++) w.send({ t: "stdout", execId: "e", data: t.encodeData(new Uint8Array(i * 1000).fill(i)) })
      })()`,
      ctx,
    )

    // Host side: node:crypto wrapE2E with the crossed keys.
    const hostHandlers = new Set<(f: TunnelFrame) => void>()
    const hostSink: FrameSink = {
      isOpen: true,
      send: f => (ctx.__fromHost as (t: string) => void)(JSON.stringify(f)),
      close() {},
      onFrame: h => (hostHandlers.add(h), () => hostHandlers.delete(h)),
      onClose: () => () => {},
    }
    const host = wrapE2E(hostSink, { sendKey: recvKey, recvKey: sendKey })
    const atHost: TunnelFrame[] = []
    host.onFrame(f => atHost.push(f))

    await vi.waitFor(() => expect(toHost).toHaveLength(20))
    for (const text of toHost) for (const h of hostHandlers) h(JSON.parse(text))
    await vi.waitFor(() => expect(atHost).toHaveLength(20))
    atHost.forEach((f, i) => {
      expect(f.t).toBe("stdout")
      if (f.t === "stdout") expect(Buffer.from(f.data, "base64").equals(Buffer.alloc(i * 1000, i))).toBe(true)
    })

    host.send({ t: "ping", nonce: "from-node" })
    host.send({ t: "stdout", execId: "e", data: Buffer.alloc(4096, 1).toString("base64") })
    await vi.waitFor(() => expect(vm.runInContext("__got", ctx)).toEqual(["ping", 4096]))
  }, 30_000)
})
