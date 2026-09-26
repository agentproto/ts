/**
 * Browser-safety check for `@agentproto/secrets/pairing/browser`.
 *
 *   1. Static: bundle the entry with esbuild for `platform: "browser"`; any
 *      import of a Node builtin (`node:*` or a bare builtin name) anywhere in
 *      the reachable graph fails the test, with the importing file named.
 *      The same check run on the Node entry must flag it — so the check has
 *      teeth.
 *   2. Runtime: evaluate the bundle in a fresh VM context that has only web
 *      globals (WebCrypto, TextEncoder/Decoder, URL, timers) — no `Buffer`, no
 *      `process`, no `require` — and run a real pairing in it, against a
 *      `node:crypto` daemon running in this (Node) realm.
 */

import { describe, it, expect } from "vitest"
import { builtinModules } from "node:module"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { build, type Plugin } from "esbuild"
import {
  respondToHandshake,
  decodePairingHello,
  encodePairingMessage,
  derivePairRoot,
  deriveOfferTokens,
  encodeOfferUrl,
} from "../pairing/index.js"
import { generateIdentity, identityFingerprint } from "../identity/index.js"

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

const browserEntry = fileURLToPath(new URL("../pairing/browser.ts", import.meta.url))
const nodeEntry = fileURLToPath(new URL("../pairing/index.ts", import.meta.url))

/** A realm with web globals only. */
function browserLikeContext(): vm.Context {
  return vm.createContext({
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  })
}

describe("@agentproto/secrets/pairing/browser is browser-safe", () => {
  it("reaches no Node builtin (and the check does catch one in the Node entry)", async () => {
    const browser = await bundleForBrowser(browserEntry)
    expect(browser.offenders).toEqual([])

    const node = await bundleForBrowser(nodeEntry)
    expect(node.offenders.some(o => o.startsWith("node:crypto"))).toBe(true)
  }, 30_000)

  it("runs a pairing in a realm without Buffer/process, against a node:crypto daemon", async () => {
    const { code } = await bundleForBrowser(browserEntry)
    const ctx = browserLikeContext()
    vm.runInContext(code, ctx)
    expect(vm.runInContext("typeof Buffer + typeof process + typeof require", ctx)).toBe(
      "undefinedundefinedundefined",
    )

    const identity = await generateIdentity() // daemon side: node:crypto, this realm
    const offerUrl = encodeOfferUrl({
      v: 2,
      rendezvousUrl: "wss://rdv.example/v1",
      fingerprint: await identityFingerprint(identity.x25519.pub),
      daemonX25519Pub: identity.x25519.pub,
      daemonEd25519Pub: identity.ed25519.pub,
      secret: "AAAABBBBCCCCDDDDEEEEFF",
      exp: Math.floor(Date.now() / 1000) + 600,
    })

    // Client side, inside the browser-like realm. Only strings cross realms.
    ctx.offerUrl = offerUrl
    const clientRun = vm.runInContext(
      `(async () => {
        const p = __entry
        const offer = await p.parseOfferUrl(offerUrl, { now: Date.now() })
        const started = await p.startClientHandshake({
          daemonX25519Pub: offer.daemonX25519Pub,
          daemonEd25519Pub: offer.daemonEd25519Pub,
          authToken: (await p.deriveOfferTokens(offer.secret)).auth,
          clientName: "browser@vm",
        })
        globalThis.__complete = async replyB64 => {
          const s = await started.complete(p.decodePairingReply(p.base64Decode(replyB64)))
          return {
            root: await p.derivePairRoot(s),
            fp: s.peerFingerprint,
            send: p.base64Encode(s.sendKey),
            recv: p.base64Encode(s.recvKey),
          }
        }
        return p.base64Encode(p.encodePairingMessage(started.hello))
      })()`,
      ctx,
    ) as Promise<string>
    const helloB64 = await clientRun

    const { reply, session } = await respondToHandshake(
      decodePairingHello(Buffer.from(helloB64, "base64")),
      {
        identity,
        // The browser realm derived `auth` with WebCrypto; this realm derives it
        // with node:crypto — equality proves the derivation is portable.
        verifyAuthToken: async t => t === (await deriveOfferTokens("AAAABBBBCCCCDDDDEEEEFF")).auth,
      },
    )
    ctx.replyB64 = Buffer.from(encodePairingMessage(reply)).toString("base64")
    const client = (await vm.runInContext("__complete(replyB64)", ctx)) as {
      root: string
      fp: string
      send: string
      recv: string
    }

    expect(session.clientName).toBe("browser@vm")
    expect(client.fp).toBe(await identityFingerprint(identity.x25519.pub))
    expect(client.send).toBe(Buffer.from(session.recvKey).toString("base64"))
    expect(client.recv).toBe(Buffer.from(session.sendKey).toString("base64"))
    expect(client.root).toBe(await derivePairRoot(session))
  }, 30_000)
})
