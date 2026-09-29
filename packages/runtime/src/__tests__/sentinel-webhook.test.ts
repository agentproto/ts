/**
 * Tests for the `webhook` sentinel provider (AIP-60 step 5): hook lifecycle
 * (create / share / refcount / re-point), readiness, HMAC verification,
 * delivery-id dedup through the runtime, and the auto-select rule.
 *
 * `gh` is a fake that records every call (args + stdin) and models just
 * enough of the repo-hooks API; nothing here touches the network or the real
 * `~/.agentproto`.
 */

import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { createSentinelStore } from "../sentinel-store.js"
import { createWebhookHookStore } from "../sentinel-providers/webhook-hooks.js"
import { WebhookSetupError, webhookSentinelProvider, type WebhookGhRunner } from "../sentinel-providers/webhook.js"
import { createFakeSentinelProvider } from "../sentinel-providers/fake.js"
import { deliveryPreferenceFor, singleMatch, type SentinelProviderHandle, type SentinelSpec } from "../sentinel-providers/types.js"
import { createSentinelWatch } from "../sentinel-tools.js"
import type { SentinelPublicUrl } from "../sentinel-public-url.js"
import type { SessionMessage } from "../session-message.js"
import type { SendMessageResult } from "../sessions.js"

// ── Fake gh ──────────────────────────────────────────────────────────

interface GhCall {
  args: string[]
  input?: string
}

interface FakeGh {
  run: WebhookGhRunner
  calls: GhCall[]
  /** Hooks as GitHub holds them, by id. */
  hooks: Map<number, { active: boolean; config: { url: string; secret?: string } }>
  scopesHeader: string | null
  authFails: boolean
  createError?: Error
}

function makeFakeGh(): FakeGh {
  let nextId = 1000
  const calls: GhCall[] = []
  const hooks: FakeGh["hooks"] = new Map()
  const fake: FakeGh = {
    calls,
    hooks,
    scopesHeader: "repo, admin:repo_hook",
    authFails: false,
    run: async (args, opts) => {
      calls.push({ args: [...args], ...(opts?.input !== undefined ? { input: opts.input } : {}) })
      const joined = args.join(" ")
      if (args[0] === "auth") return "ok"
      if (joined === "api -i user") {
        if (fake.authFails) throw new Error("gh: To get started with GitHub CLI, please run: gh auth login")
        return `HTTP/2.0 200 OK\r\n${fake.scopesHeader !== null ? `X-Oauth-Scopes: ${fake.scopesHeader}\r\n` : ""}Content-Type: application/json\r\n\r\n{"login":"me"}`
      }
      const method = args.includes("-X") ? args[args.indexOf("-X") + 1]! : "GET"
      const path = args.find(a => a.startsWith("repos/")) ?? ""
      const hookId = /\/hooks\/(\d+)$/.exec(path)?.[1]
      if (method === "POST" && path.endsWith("/hooks")) {
        if (fake.createError) throw fake.createError
        const body = JSON.parse(opts?.input ?? "{}") as { config: { url: string; secret: string } }
        const id = ++nextId
        hooks.set(id, { active: true, config: body.config })
        return JSON.stringify({ id })
      }
      if (hookId) {
        const id = Number(hookId)
        const hook = hooks.get(id)
        if (!hook) throw new Error(`gh: Not Found (HTTP 404)`)
        if (method === "GET") return JSON.stringify({ id, active: hook.active, config: { url: hook.config.url } })
        if (method === "PATCH") {
          const body = JSON.parse(opts?.input ?? "{}") as { config: { url: string; secret: string } }
          hook.config = body.config
          return "{}"
        }
        if (method === "DELETE") {
          hooks.delete(id)
          return ""
        }
      }
      throw new Error(`fakeGh: unexpected call ${joined}`)
    },
  }
  return fake
}

const ORIGIN = "https://hooks.example.com"
const stable = (url = ORIGIN): SentinelPublicUrl => ({ url, stable: true, source: "env" })

function harness(overrides?: { publicUrl?: () => SentinelPublicUrl | undefined }) {
  const gh = makeFakeGh()
  const hooks = createWebhookHookStore({ persist: false })
  let current: SentinelPublicUrl | undefined = stable()
  const provider = webhookSentinelProvider({
    gh: gh.run,
    hooks,
    publicUrl: overrides?.publicUrl ?? (() => current),
    now: () => new Date("2026-09-28T10:00:00.000Z"),
  })
  return { gh, hooks, provider, setUrl: (u: SentinelPublicUrl | undefined) => (current = u) }
}

const specFor = (subject: string): SentinelSpec => ({
  match: singleMatch(subject),
  until: { kind: "never" },
  target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
  provider: "webhook",
})

const PUSH = deliveryPreferenceFor({ capabilities: { poll: false, push: true } } as never, 15_000)

const sign = (body: string, secret: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

const PR_CLOSED = JSON.stringify({
  action: "closed",
  number: 12,
  pull_request: { number: 12, title: "t", html_url: "https://github.com/o/r/pull/12", merged: true, head: { sha: "s1" } },
  repository: { full_name: "o/r" },
  sender: { login: "alice" },
})

function deliveryHeaders(body: string, secret: string, id: string, event = "pull_request") {
  return {
    "x-hub-signature-256": sign(body, secret),
    "x-github-event": event,
    "x-github-delivery": id,
    "content-type": "application/json",
  }
}

const posts = (gh: FakeGh): GhCall[] => gh.calls.filter(c => c.args.includes("POST"))

// ── Provider: create / share / cancel ────────────────────────────────

describe("webhook provider — create/cancel", () => {
  it("creates a repo hook via gh with the secret on stdin (never argv), 0 secrets in the handle", async () => {
    const { gh, hooks, provider } = harness()
    const handle = await provider.create(specFor("github:o/r#12"), PUSH)

    expect(posts(gh)).toHaveLength(1)
    const call = posts(gh)[0]!
    expect(call.args).toContain("repos/o/r/hooks")
    expect(call.args).toContain("--input")
    const rec = hooks.getByRepo("o/r")!
    expect(rec.secret).toMatch(/^[0-9a-f]{64}$/)
    // the secret is only in the stdin body…
    expect(call.input).toContain(rec.secret)
    // …never in argv or the handle
    expect(call.args.join(" ")).not.toContain(rec.secret)
    expect(JSON.stringify(handle)).not.toContain(rec.secret)
    expect(JSON.parse(call.input!)).toMatchObject({
      name: "web",
      active: true,
      config: { url: `${ORIGIN}/inbound/sentinel-${rec.key}`, content_type: "json" },
    })
    expect(JSON.parse(call.input!).events).toEqual(
      expect.arrayContaining(["pull_request", "pull_request_review", "check_suite", "workflow_run", "issue_comment"]),
    )
    expect(handle.provider).toBe("webhook")
    expect(handle.state).toMatchObject({ repo: "o/r", hookKey: rec.key })
    expect(handle.remoteId).toBe(String(rec.hookId))
  })

  it("shares ONE hook across sentinels on the same repo (PR + repo subjects)", async () => {
    const { gh, hooks, provider } = harness()
    const a = await provider.create(specFor("github:o/r#12"), PUSH)
    const b = await provider.create(specFor("github:o/r*"), PUSH)
    const c = await provider.create(specFor("github:o/r"), PUSH)

    expect(posts(gh)).toHaveLength(1)
    expect(a.state?.hookKey).toBe(b.state?.hookKey)
    expect(a.state?.hookKey).toBe(c.state?.hookKey)
    expect(new Set([a.state?.holder, b.state?.holder, c.state?.holder]).size).toBe(3)
    expect(hooks.getByRepo("o/r")!.holders).toHaveLength(3)
  })

  it("uses a separate hook per repo", async () => {
    const { gh, provider } = harness()
    const a = await provider.create(specFor("github:o/r#1"), PUSH)
    const b = await provider.create(specFor("github:o/other#1"), PUSH)
    expect(posts(gh)).toHaveLength(2)
    expect(a.state?.hookKey).not.toBe(b.state?.hookKey)
  })

  it("serializes concurrent creates on one repo into a single hook", async () => {
    const { gh, hooks, provider } = harness()
    await Promise.all([1, 2, 3, 4].map(n => provider.create(specFor(`github:o/r#${n}`), PUSH)))
    expect(posts(gh)).toHaveLength(1)
    expect(hooks.getByRepo("o/r")!.holders).toHaveLength(4)
  })

  it("deletes the hook only when the LAST sentinel cancels (refcount)", async () => {
    const { gh, hooks, provider } = harness()
    const a = await provider.create(specFor("github:o/r#1"), PUSH)
    const b = await provider.create(specFor("github:o/r#2"), PUSH)
    const hookId = hooks.getByRepo("o/r")!.hookId
    const deletes = () => gh.calls.filter(c => c.args.includes("DELETE"))

    await provider.cancel(a)
    expect(deletes()).toHaveLength(0)
    expect(gh.hooks.has(hookId)).toBe(true)
    expect(hooks.getByRepo("o/r")!.holders).toHaveLength(1)

    await provider.cancel(b)
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0]!.args).toContain(`repos/o/r/hooks/${hookId}`)
    expect(gh.hooks.has(hookId)).toBe(false)
    expect(hooks.getByRepo("o/r")).toBeUndefined()
  })

  it("cancel is idempotent (expiry then unwatch must not drop a sibling's hook)", async () => {
    const { gh, hooks, provider } = harness()
    const a = await provider.create(specFor("github:o/r#1"), PUSH)
    await provider.create(specFor("github:o/r#2"), PUSH)

    await provider.cancel(a)
    await provider.cancel(a)
    expect(gh.calls.filter(c => c.args.includes("DELETE"))).toHaveLength(0)
    expect(hooks.getByRepo("o/r")!.holders).toHaveLength(1)
  })

  it("a fresh hook is created after the last one was deleted", async () => {
    const { gh, provider } = harness()
    const a = await provider.create(specFor("github:o/r#1"), PUSH)
    await provider.cancel(a)
    await provider.create(specFor("github:o/r#1"), PUSH)
    expect(posts(gh)).toHaveLength(2)
  })

  it("treats a 404 on delete as already gone", async () => {
    const { gh, hooks, provider } = harness()
    const a = await provider.create(specFor("github:o/r#1"), PUSH)
    gh.hooks.clear()
    await expect(provider.cancel(a)).resolves.toBeUndefined()
    expect(hooks.getByRepo("o/r")).toBeUndefined()
  })

  it("keeps the record (unheld) and rethrows when the delete fails for real", async () => {
    const { gh, hooks, provider } = harness()
    const a = await provider.create(specFor("github:o/r#1"), PUSH)
    const run = gh.run
    const failing: WebhookGhRunner = async (args, opts) => {
      if (args.includes("DELETE")) throw new Error("gh: Server Error (HTTP 500)")
      return run(args, opts)
    }
    const p2 = webhookSentinelProvider({ gh: failing, hooks, publicUrl: () => stable() })
    await expect(p2.cancel(a)).rejects.toThrow(/500/)
    expect(hooks.getByRepo("o/r")!.holders).toEqual([])
    // a later create reuses the existing hook instead of posting a second one
    const before = posts(gh).length
    await provider.create(specFor("github:o/r#2"), PUSH)
    expect(posts(gh)).toHaveLength(before)
  })

  it("re-creates the hook (same route key, new secret) when it was deleted on GitHub", async () => {
    const { gh, hooks, provider } = harness()
    const a = await provider.create(specFor("github:o/r#1"), PUSH)
    const before = hooks.getByRepo("o/r")!
    gh.hooks.clear()

    const b = await provider.create(specFor("github:o/r#2"), PUSH)
    const after = hooks.getByRepo("o/r")!
    expect(posts(gh)).toHaveLength(2)
    expect(after.key).toBe(before.key)
    expect(after.hookId).not.toBe(before.hookId)
    expect(after.secret).not.toBe(before.secret)
    expect(after.holders).toHaveLength(2)
    expect(a.state?.hookKey).toBe(b.state?.hookKey)
  })

  it("rejects subjects it cannot serve and mixed-repo clauses", async () => {
    const { provider } = harness()
    await expect(provider.create(specFor("linear:ABC-1"), PUSH)).rejects.toThrow(/not supported/)
    await expect(
      provider.create(
        { ...specFor("github:o/r#1"), match: [...singleMatch("github:o/r#1"), ...singleMatch("github:o/x#2")] },
        PUSH,
      ),
    ).rejects.toThrow(/one repository/)
  })

  it("advertises push-only capabilities and default types", () => {
    const { provider } = harness()
    expect(provider.capabilities).toMatchObject({ push: true, poll: false, needsPublicUrl: true })
    expect(provider.defaultTypes?.("github:o/r#1")).toContain("github.pull_request.closed")
    expect(provider.defaultTypes?.("linear:ABC-1")).toEqual([])
  })
})

// ── Setup errors / readiness ─────────────────────────────────────────

describe("webhook provider — unavailable", () => {
  it("create fails with a clear setup error when there is no public URL (no fallback, no gh call)", async () => {
    const { gh, provider, setUrl } = harness()
    setUrl(undefined)
    const err = await provider.create(specFor("github:o/r#1"), PUSH).catch(e => e)
    expect(err).toBeInstanceOf(WebhookSetupError)
    expect(String(err.message)).toMatch(/AGENTPROTO_PUBLIC_URL/)
    expect(gh.calls).toHaveLength(0)
  })

  it("create maps a 403/404 from GitHub to an actionable setup error naming the scope", async () => {
    const { gh, provider } = harness()
    gh.createError = new Error("gh api failed: Must have admin rights to Repository. (HTTP 403)")
    const err = await provider.create(specFor("github:o/r#1"), PUSH).catch(e => e)
    expect(err).toBeInstanceOf(WebhookSetupError)
    expect(String(err.message)).toMatch(/admin:repo_hook/)
  })

  it("readiness: not ready without a public URL, with the reason", async () => {
    const { provider, setUrl } = harness()
    setUrl(undefined)
    const r = await provider.readiness!()
    expect(r.ready).toBe(false)
    expect(r.reason).toMatch(/public URL/)
  })

  it("readiness: not ready when the token lacks hook scope; names the fix", async () => {
    const { gh, provider } = harness()
    gh.scopesHeader = "gist, read:org"
    const r = await provider.readiness!()
    expect(r.ready).toBe(false)
    expect(r.reason).toMatch(/admin:repo_hook/)
    expect(r.reason).toMatch(/gh auth refresh/)
  })

  it.each(["admin:repo_hook", "write:repo_hook", "repo, gist"])("readiness: ready with scope %s", async scopes => {
    const { gh, provider } = harness()
    gh.scopesHeader = scopes
    expect(await provider.readiness!()).toEqual({ ready: true })
  })

  it("readiness: ready when no scopes header (fine-grained / app token)", async () => {
    const { gh, provider } = harness()
    gh.scopesHeader = null
    expect(await provider.readiness!()).toEqual({ ready: true })
  })

  it("readiness: not ready when gh is unauthenticated", async () => {
    const { gh, provider } = harness()
    gh.authFails = true
    const r = await provider.readiness!()
    expect(r.ready).toBe(false)
    expect(r.reason).toMatch(/gh auth login/)
  })
})

// ── URL rotation ─────────────────────────────────────────────────────

describe("webhook provider — public URL rotation", () => {
  it("attach re-points the hook (PATCH, same key + secret) when the public URL changed", async () => {
    const { gh, hooks, provider, setUrl } = harness()
    const handle = await provider.create(specFor("github:o/r#1"), PUSH)
    const rec = hooks.getByRepo("o/r")!

    setUrl(stable("https://new.example.org"))
    const re = await provider.attach(handle, PUSH)

    const patches = gh.calls.filter(c => c.args.includes("PATCH"))
    expect(patches).toHaveLength(1)
    expect(patches[0]!.args).toContain(`repos/o/r/hooks/${rec.hookId}`)
    const body = JSON.parse(patches[0]!.input!) as { config: { url: string; secret: string } }
    expect(body.config.url).toBe(`https://new.example.org/inbound/sentinel-${rec.key}`)
    expect(body.config.secret).toBe(rec.secret)
    expect(gh.calls.filter(c => c.args.includes("POST"))).toHaveLength(1)
    expect(hooks.getByRepo("o/r")!.origin).toBe("https://new.example.org")
    expect(re.state).toEqual(handle.state)
    // the secret still never rides argv
    expect(patches[0]!.args.join(" ")).not.toContain(rec.secret)
  })

  it("attach with an unchanged URL makes no gh call", async () => {
    const { gh, provider } = harness()
    const handle = await provider.create(specFor("github:o/r#1"), PUSH)
    const n = gh.calls.length
    await provider.attach(handle, PUSH)
    expect(gh.calls).toHaveLength(n)
  })

  it("attach re-points once for several sentinels sharing the hook", async () => {
    const { gh, provider, setUrl } = harness()
    const a = await provider.create(specFor("github:o/r#1"), PUSH)
    const b = await provider.create(specFor("github:o/r#2"), PUSH)
    setUrl(stable("https://new.example.org"))
    await provider.attach(a, PUSH)
    await provider.attach(b, PUSH)
    expect(gh.calls.filter(c => c.args.includes("PATCH"))).toHaveLength(1)
  })

  it("attach re-creates the hook when the PATCH finds it deleted, keeping the route key", async () => {
    const { gh, hooks, provider, setUrl } = harness()
    const handle = await provider.create(specFor("github:o/r#1"), PUSH)
    const key = hooks.getByRepo("o/r")!.key
    gh.hooks.clear()
    setUrl(stable("https://new.example.org"))

    await provider.attach(handle, PUSH)
    const rec = hooks.getByRepo("o/r")!
    expect(rec.key).toBe(key)
    expect(gh.hooks.get(rec.hookId)!.config.url).toBe(`https://new.example.org/inbound/sentinel-${key}`)
  })

  it("attach re-registers the holder after the hook store was lost (e.g. wiped file)", async () => {
    const { hooks, provider } = harness()
    const handle = await provider.create(specFor("github:o/r#1"), PUSH)
    const key = hooks.getByRepo("o/r")!.key
    hooks.remove("o/r")

    const re = await provider.attach(handle, PUSH)
    expect(re.state?.hookKey).toBe(key)
    expect(hooks.getByRepo("o/r")!.holders).toEqual([handle.state!.holder])
  })

  it("attach is tolerant of no public URL yet: handle returned unchanged, no throw, no gh call", async () => {
    const { gh, provider, setUrl } = harness()
    const handle = await provider.create(specFor("github:o/r#1"), PUSH)
    const n = gh.calls.length
    setUrl(undefined)
    await expect(provider.attach(handle, PUSH)).resolves.toEqual(handle)
    expect(gh.calls).toHaveLength(n)
  })
})

// ── status ───────────────────────────────────────────────────────────

describe("webhook provider — status", () => {
  it("ok when the hook exists, is active, and points here", async () => {
    const { provider } = harness()
    const handle = await provider.create(specFor("github:o/r#1"), PUSH)
    expect(await provider.status!(handle)).toEqual({ ok: true })
  })

  it("reports a deleted hook, a disabled hook, and a hook pointing elsewhere", async () => {
    const { gh, hooks, provider } = harness()
    const handle = await provider.create(specFor("github:o/r#1"), PUSH)
    const id = hooks.getByRepo("o/r")!.hookId

    gh.hooks.get(id)!.active = false
    expect((await provider.status!(handle)).detail).toMatch(/disabled/)
    gh.hooks.get(id)!.active = true

    gh.hooks.get(id)!.config.url = "https://elsewhere.example/x"
    expect((await provider.status!(handle)).detail).toMatch(/no longer points/)

    gh.hooks.clear()
    expect((await provider.status!(handle)).detail).toMatch(/deleted/)
  })

  it("not ok when the local record is gone", async () => {
    const { hooks, provider } = harness()
    const handle = await provider.create(specFor("github:o/r#1"), PUSH)
    hooks.remove("o/r")
    expect((await provider.status!(handle)).ok).toBe(false)
  })
})

// ── parseInbound: signature + normalization ──────────────────────────

describe("webhook provider — parseInbound", () => {
  async function ready() {
    const h = harness()
    const handle = await h.provider.create(specFor("github:o/r#12"), PUSH)
    const rec = h.hooks.getByRepo("o/r")!
    return { ...h, handle, rec }
  }

  it("accepts a correctly signed delivery and normalizes it (event id = evt_<delivery>)", async () => {
    const { provider, handle, rec } = await ready()
    const result = provider.parseInbound!({ rawBody: PR_CLOSED, headers: deliveryHeaders(PR_CLOSED, rec.secret, "del-1") }, handle)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      id: "evt_del-1",
      type: "github.pull_request.closed",
      subject: "github:o/r#12",
      terminal: true,
    })
  })

  it("401-class: a bad signature is rejected", async () => {
    const { provider, handle, rec } = await ready()
    const headers = { ...deliveryHeaders(PR_CLOSED, rec.secret, "del-1"), "x-hub-signature-256": sign(PR_CLOSED, "wrong-secret") }
    expect(provider.parseInbound!({ rawBody: PR_CLOSED, headers }, handle)).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("rejects a tampered body", async () => {
    const { provider, handle, rec } = await ready()
    const headers = deliveryHeaders(PR_CLOSED, rec.secret, "del-1")
    expect(provider.parseInbound!({ rawBody: PR_CLOSED.replace("alice", "mallory"), headers }, handle)).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  it("rejects a malformed signature header", async () => {
    const { provider, handle, rec } = await ready()
    for (const bad of ["deadbeef", "sha256=", "sha256=zz", "sha1=" + "0".repeat(40), "sha256=" + "0".repeat(10)]) {
      const headers = { ...deliveryHeaders(PR_CLOSED, rec.secret, "d"), "x-hub-signature-256": bad }
      expect(provider.parseInbound!({ rawBody: PR_CLOSED, headers }, handle)).toEqual({ ok: false, reason: "bad_signature" })
    }
  })

  it("a missing signature header is rejected as missing_signature", async () => {
    const { provider, handle, rec } = await ready()
    const { "x-hub-signature-256": _drop, ...headers } = deliveryHeaders(PR_CLOSED, rec.secret, "del-1")
    expect(provider.parseInbound!({ rawBody: PR_CLOSED, headers }, handle)).toEqual({ ok: false, reason: "missing_signature" })
  })

  it("event/delivery header lookup is case-insensitive (Node lower-cases the signature header itself)", async () => {
    const { provider, handle, rec } = await ready()
    const headers = {
      "x-hub-signature-256": sign(PR_CLOSED, rec.secret),
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "del-9",
    }
    expect(provider.parseInbound!({ rawBody: PR_CLOSED, headers }, handle).ok).toBe(true)
  })

  it("an unknown hook key is unknown_hook (signature never checked against anything)", async () => {
    const { provider } = await ready()
    expect(
      provider.parseInbound!(
        { rawBody: PR_CLOSED, headers: deliveryHeaders(PR_CLOSED, "x", "d") },
        { provider: "webhook", state: { hookKey: "nope" } },
      ),
    ).toEqual({ ok: false, reason: "unknown_hook" })
  })

  it("a signature made with a DIFFERENT repo's secret is rejected", async () => {
    const h = harness()
    const a = await h.provider.create(specFor("github:o/r#1"), PUSH)
    await h.provider.create(specFor("github:o/other#1"), PUSH)
    const otherSecret = h.hooks.getByRepo("o/other")!.secret
    const headers = deliveryHeaders(PR_CLOSED, otherSecret, "d")
    expect(h.provider.parseInbound!({ rawBody: PR_CLOSED, headers }, a)).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("ping and unsupported events are acked with zero events", async () => {
    const { provider, handle, rec } = await ready()
    const ping = JSON.stringify({ zen: "hi", hook_id: 1 })
    expect(provider.parseInbound!({ rawBody: ping, headers: deliveryHeaders(ping, rec.secret, "p1", "ping") }, handle)).toEqual({
      ok: true,
      events: [],
    })
    const push = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "o/r" } })
    expect(provider.parseInbound!({ rawBody: push, headers: deliveryHeaders(push, rec.secret, "p2", "push") }, handle)).toEqual({
      ok: true,
      events: [],
    })
  })

  it("requires the event and delivery headers, and valid JSON (all AFTER the signature)", async () => {
    const { provider, handle, rec } = await ready()
    const base = deliveryHeaders(PR_CLOSED, rec.secret, "d")
    const { "x-github-event": _e, ...noEvent } = base
    const { "x-github-delivery": _d, ...noDelivery } = base
    expect(provider.parseInbound!({ rawBody: PR_CLOSED, headers: noEvent }, handle)).toEqual({ ok: false, reason: "missing_event_header" })
    expect(provider.parseInbound!({ rawBody: PR_CLOSED, headers: noDelivery }, handle)).toEqual({ ok: false, reason: "missing_delivery_header" })
    const junk = "not json"
    expect(provider.parseInbound!({ rawBody: junk, headers: deliveryHeaders(junk, rec.secret, "d") }, handle)).toEqual({
      ok: false,
      reason: "invalid_json",
    })
  })

  it("surfaces a normalizer failure for a supported event with a malformed payload", async () => {
    const { provider, handle, rec } = await ready()
    const body = JSON.stringify({ action: "closed" })
    const result = provider.parseInbound!({ rawBody: body, headers: deliveryHeaders(body, rec.secret, "d") }, handle)
    expect(result.ok).toBe(false)
  })
})

// ── Dedup + delivery through the runtime ─────────────────────────────

function stubRegistry(fail = false): SentinelRuntimeRegistry & { texts: string[] } {
  const texts: string[] = []
  return {
    texts,
    async sendMessage(msg: SessionMessage): Promise<SendMessageResult> {
      if (fail) throw new Error("boom")
      texts.push(msg.text)
      return { messageId: "m", delivered: { via: "turn" }, queued: false, urgencyApplied: "next-turn" }
    },
  }
}

describe("webhook provider — delivery + dedup through the runtime", () => {
  async function wire(opts?: { failSend?: boolean }) {
    const h = harness()
    const handle = await h.provider.create(specFor("github:o/r#12"), PUSH)
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({
      provider: "webhook",
      handle,
      spec: { ...specFor("github:o/r#12"), match: singleMatch("github:o/r#12"), until: { kind: "never" } },
    })
    const registry = stubRegistry(opts?.failSend)
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: async slug => (slug === "webhook" ? h.provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      log: () => {},
    })
    const rec = h.hooks.getByRepo("o/r")!
    const parse = (id: string, body = PR_CLOSED) => {
      const r = h.provider.parseInbound!({ rawBody: body, headers: deliveryHeaders(body, rec.secret, id) }, handle)
      if (!r.ok) throw new Error(r.reason)
      return r.events
    }
    return { ...h, handle, store, sentinel, registry, runtime, parse }
  }

  it("delivers a pushed event once and dedups a redelivery with the same X-GitHub-Delivery", async () => {
    const { runtime, registry, parse, sentinel } = await wire()
    const first = await runtime.deliverPushed(sentinel.id, parse("del-7"))
    expect(first).toEqual({ delivered: 1, failed: false })
    expect(registry.texts).toHaveLength(1)
    expect(registry.texts[0]).toContain("merged")

    const again = await runtime.deliverPushed(sentinel.id, parse("del-7"))
    expect(again).toEqual({ delivered: 0, failed: false })
    expect(registry.texts).toHaveLength(1)
  })

  it("a different delivery id for the same content is delivered (dedup is per-delivery)", async () => {
    const { runtime, registry, parse, sentinel } = await wire()
    await runtime.deliverPushed(sentinel.id, parse("del-a"))
    await runtime.deliverPushed(sentinel.id, parse("del-b"))
    expect(registry.texts).toHaveLength(2)
  })

  it("concurrent duplicate deliveries deliver exactly once", async () => {
    const { runtime, registry, parse, sentinel } = await wire()
    await Promise.all([1, 2, 3].map(() => runtime.deliverPushed(sentinel.id, parse("del-c"))))
    expect(registry.texts).toHaveLength(1)
  })

  it("a terminal (merged) event with until: subject_terminal expires the sentinel and cancels its holder", async () => {
    const h = await wire()
    const s2 = h.store.create({
      provider: "webhook",
      handle: h.handle,
      spec: { ...h.sentinel.spec, until: { kind: "subject_terminal" } },
    })
    await h.runtime.deliverPushed(s2.id, h.parse("del-t"))
    expect(h.store.get(s2.id)?.status).toBe("expired")
  })

  it("a failed delivery is NOT marked seen, so the redelivery is delivered", async () => {
    const h = await wire({ failSend: true })
    const r1 = await h.runtime.deliverPushed(h.sentinel.id, h.parse("del-f"))
    expect(r1.failed).toBe(true)
    expect(h.store.get(h.sentinel.id)?.seen ?? []).not.toContain("evt_del-f")
  })

  it("does not deliver to sentinels whose subject doesn't match the event", async () => {
    const h = await wire()
    const other = h.store.create({
      provider: "webhook",
      handle: h.handle,
      spec: { ...h.sentinel.spec, match: singleMatch("github:o/r#999") },
    })
    const r = await h.runtime.deliverPushed(other.id, h.parse("del-m"))
    expect(r.delivered).toBe(0)
  })

  it("a repo-wide subject (github:o/r*) receives PR-scoped events", async () => {
    const h = await wire()
    const wide = h.store.create({
      provider: "webhook",
      handle: h.handle,
      spec: { ...h.sentinel.spec, match: singleMatch("github:o/r*") },
    })
    const r = await h.runtime.deliverPushed(wide.id, h.parse("del-w"))
    expect(r.delivered).toBe(1)
  })

  it("deliverPushed on an unknown sentinel is a quiet no-op", async () => {
    const h = await wire()
    expect(await h.runtime.deliverPushed("sent_nope", h.parse("del-x"))).toEqual({ delivered: 0, failed: false })
  })
})

// ── Hook store ───────────────────────────────────────────────────────

describe("webhook hook store", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("persists to a 0600 file and reloads across instances (refcount survives restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-store-"))
    dirs.push(dir)
    const filePath = join(dir, "sentinel-webhooks.json")
    const gh = makeFakeGh()
    const store1 = createWebhookHookStore({ filePath })
    const p1 = webhookSentinelProvider({ gh: gh.run, hooks: store1, publicUrl: () => stable() })
    const handle = await p1.create(specFor("github:o/r#1"), PUSH)

    expect(statSync(filePath).mode & 0o777).toBe(0o600)

    const store2 = createWebhookHookStore({ filePath })
    const rec = store2.getByRepo("o/r")!
    expect(rec.holders).toEqual([handle.state!.holder])
    expect(store2.getByKey(rec.key)?.repo).toBe("o/r")

    const p2 = webhookSentinelProvider({ gh: gh.run, hooks: store2, publicUrl: () => stable() })
    await p2.cancel(handle)
    expect(gh.calls.filter(c => c.args.includes("DELETE"))).toHaveLength(1)
    expect(createWebhookHookStore({ filePath }).getByRepo("o/r")).toBeUndefined()
  })

  it("withRepoLock serializes per repo but not across repos", async () => {
    const store = createWebhookHookStore({ persist: false })
    const order: string[] = []
    const slow = store.withRepoLock("a/a", async () => {
      await new Promise(r => setTimeout(r, 20))
      order.push("a1")
    })
    const queued = store.withRepoLock("a/a", async () => void order.push("a2"))
    const other = store.withRepoLock("b/b", async () => void order.push("b"))
    await Promise.all([slow, queued, other])
    expect(order).toEqual(["b", "a1", "a2"])
  })

  it("a failing locked section does not wedge the lock", async () => {
    const store = createWebhookHookStore({ persist: false })
    await expect(store.withRepoLock("a/a", async () => Promise.reject(new Error("x")))).rejects.toThrow("x")
    await expect(store.withRepoLock("a/a", async () => 5)).resolves.toBe(5)
  })
})

// ── Auto-select ──────────────────────────────────────────────────────

describe("createSentinelWatch — provider auto-select", () => {
  function deps(opts: { publicUrl: () => SentinelPublicUrl | undefined; scopes?: string | null }) {
    const h = harness({ publicUrl: opts.publicUrl })
    if (opts.scopes !== undefined) h.gh.scopesHeader = opts.scopes
    const localGh = createFakeSentinelProvider({ slug: "local-gh" })
    const store = createSentinelStore({ persist: false })
    const providers: Record<string, SentinelProviderHandle> = { webhook: h.provider, "local-gh": localGh }
    return {
      h,
      store,
      deps: {
        store,
        resolveProvider: async (slug: string) => providers[slug] ?? null,
        isSessionAlive: () => true,
        defaultSessionId: "sess_1",
        publicUrl: opts.publicUrl,
      },
    }
  }
  const input = { prUrl: "https://github.com/o/r/pull/12" }

  it("picks webhook when a stable URL exists and the provider is ready", async () => {
    const { deps: d, h } = deps({ publicUrl: () => stable() })
    const r = await createSentinelWatch(d, input)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sentinel.provider).toBe("webhook")
    expect(posts(h.gh)).toHaveLength(1)
  })

  it("falls back to local-gh when the URL is not stable (quick tunnel)", async () => {
    const { deps: d, h } = deps({ publicUrl: () => ({ url: "https://x.trycloudflare.com", stable: false, source: "tunnel" }) })
    const r = await createSentinelWatch(d, input)
    expect(r.ok && r.sentinel.provider).toBe("local-gh")
    expect(h.gh.calls).toHaveLength(0)
  })

  it("falls back to local-gh when there is no public URL (autolink unchanged)", async () => {
    const { deps: d } = deps({ publicUrl: () => undefined })
    const r = await createSentinelWatch(d, input)
    expect(r.ok && r.sentinel.provider).toBe("local-gh")
  })

  it("falls back to local-gh when the URL is stable but webhook is not ready (missing scope)", async () => {
    const { deps: d, h } = deps({ publicUrl: () => stable(), scopes: "gist" })
    const r = await createSentinelWatch(d, input)
    expect(r.ok && r.sentinel.provider).toBe("local-gh")
    expect(posts(h.gh)).toHaveLength(0)
  })

  it("an explicit provider:'webhook' is never overridden, and fails loudly when unavailable", async () => {
    const { deps: d, store } = deps({ publicUrl: () => undefined })
    const r = await createSentinelWatch(d, { ...input, provider: "webhook" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe("provider_create_failed")
      expect(r.message).toMatch(/AGENTPROTO_PUBLIC_URL/)
    }
    expect(store.list()).toHaveLength(0)
  })

  it("an explicit provider:'webhook' is allowed on an unstable URL", async () => {
    const { deps: d } = deps({ publicUrl: () => ({ url: "https://x.trycloudflare.com", stable: false, source: "tunnel" }) })
    const r = await createSentinelWatch(d, { ...input, provider: "webhook" })
    expect(r.ok && r.sentinel.provider).toBe("webhook")
  })
})
