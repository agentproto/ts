/**
 * Shadow signal routing (plan v13, P1): the resolver picks a provider from
 * `sentinel.routes` + the builtin table, logs and stamps the decision, and
 * never changes the provider a sentinel is created on.
 */

import { describe, expect, it } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { createFakeSentinelProvider } from "../sentinel-providers/fake.js"
import type { SentinelProviderHandle } from "../sentinel-providers/types.js"
import {
  explainSentinelRoute,
  matchSentinelRoute,
  parseSentinelRoutes,
  resolveSentinelRoute,
  validateSentinelRoutes,
  type SentinelRoute,
  type SentinelRouteLogLine,
  type SentinelRoutingDeps,
} from "../sentinel-routes.js"
import { createSentinelWatch, registerSentinelTools } from "../sentinel-tools.js"
import { createSentinelStore } from "../sentinel-store.js"

/** A fake provider with a readiness probe and declared schemes. */
function provider(slug: string, subjects: string[], ready: boolean | string = true): SentinelProviderHandle {
  const fake = createFakeSentinelProvider({ slug, subjects })
  return Object.assign(fake, {
    readiness: async () => (ready === true ? { ready: true } : { ready: false, reason: typeof ready === "string" ? ready : "not ready" }),
  })
}

function resolverOf(handles: Record<string, SentinelProviderHandle | null>) {
  return async (slug: string) => handles[slug] ?? null
}

const NO_KEY = "no agentpush API key (setup_sentinel_provider agentpush)"

/** agentpush ready (declares `*`), local-gh (github), session (session). */
const readyAgentpush = () =>
  resolverOf({
    agentpush: provider("agentpush", ["*"]),
    "local-gh": provider("local-gh", ["github"]),
    session: provider("session", ["session"]),
  })

const GH_DEFAULT: SentinelRoute = { id: "gh-default", match: { subject: "github:*" }, via: ["local-gh"], fallback: "refuse", do: "deliver" }

function routing(routes: SentinelRoute[], log: SentinelRouteLogLine[]): SentinelRoutingDeps {
  return { config: () => ({ routes }), log: line => void log.push(line) }
}

describe("resolveSentinelRoute precedence", () => {
  it("an exact subject beats a longer prefix, which beats a scheme wildcard", () => {
    const routes: SentinelRoute[] = [
      { id: "scheme", match: { subject: "github:*" }, via: ["local-gh"] },
      { id: "repo", match: { subject: "github:o/r*" }, via: ["webhook"] },
      { id: "exact", match: { subject: "github:o/r#1" }, via: ["agentpush"] },
    ]
    expect(matchSentinelRoute(routes, { subject: "github:o/r#1", site: "watch" })?.id).toBe("exact")
    expect(matchSentinelRoute(routes, { subject: "github:o/r#2", site: "watch" })?.id).toBe("repo")
    expect(matchSentinelRoute(routes, { subject: "github:x/y#2", site: "watch" })?.id).toBe("scheme")
  })

  it("types and from qualifiers break subject ties, then list order wins", () => {
    const routes: SentinelRoute[] = [
      { id: "plain", match: { subject: "github:*" }, via: ["local-gh"] },
      { id: "plain-again", match: { subject: "github:*" }, via: ["webhook"] },
      { id: "glob", match: { subject: "github:*", types: ["github.check_suite.*"] }, via: ["webhook"] },
      { id: "exact-type", match: { subject: "github:*", types: ["github.issue_comment.created"] }, via: ["local-gh"] },
      { id: "autolink", match: { subject: "github:*", types: ["github.issue_comment.created"], from: { site: "autolink" } }, via: ["local-gh"] },
    ]
    expect(matchSentinelRoute(routes, { subject: "github:o/r#1", site: "watch" })?.id).toBe("plain")
    expect(matchSentinelRoute(routes, { subject: "github:o/r#1", site: "watch", types: ["github.check_suite.completed"] })?.id).toBe("glob")
    expect(matchSentinelRoute(routes, { subject: "github:o/r#1", site: "watch", types: ["github.issue_comment.created"] })?.id).toBe("exact-type")
    expect(matchSentinelRoute(routes, { subject: "github:o/r#1", site: "autolink", types: ["github.issue_comment.*"] })?.id).toBe("autolink")
  })

  it("falls back to the next ready provider with a warning for a deliver rule", async () => {
    const d = await resolveSentinelRoute(
      { subject: "github:o/r#1", site: "watch" },
      {
        resolveProvider: resolverOf({ webhook: provider("webhook", ["github"], "no public URL"), "local-gh": provider("local-gh", ["github"]) }),
        routes: [{ id: "fast", match: { subject: "github:*" }, via: ["webhook", "local-gh"] }],
      },
    )
    expect(d).toMatchObject({ slug: "local-gh", rule: "fast", fallback: "next-ready", fallbackFrom: "webhook", applied: false })
    expect(d.warning).toContain("fell back from webhook")
    expect(d.walked).toEqual([
      { provider: "webhook", rejected: "unready: no public URL", durable: false },
      { provider: "local-gh", durable: false },
    ])
  })

  it("an explicitly named provider that is not ready refuses, never falls back", async () => {
    const d = await resolveSentinelRoute(
      { subject: "telegram:x", site: "watch", provider: "agentpush" },
      { resolveProvider: resolverOf({ agentpush: provider("agentpush", ["*"], NO_KEY) }), routes: [] },
    )
    expect(d).toMatchObject({ slug: null, rule: "explicit", error: "route_unavailable" })
  })

  it("rejects a provider that does not declare the subject's scheme", async () => {
    const d = await resolveSentinelRoute(
      { subject: "telegram:x", site: "watch" },
      { resolveProvider: readyAgentpush(), routes: [{ id: "bad", match: { subject: "telegram:*" }, via: ["local-gh", "agentpush"] }] },
    )
    expect(d.walked[0]).toMatchObject({ provider: "local-gh", rejected: expect.stringContaining('does not serve scheme "telegram"') })
    expect(d.slug).toBe("agentpush")
  })
})

describe("parse + validate", () => {
  it("drops invalid rows with a warning and flags never-winning, forward-without-url and scheme mismatches", async () => {
    const { routes, warnings } = parseSentinelRoutes([GH_DEFAULT, { id: "broken" }, { ...GH_DEFAULT, id: "dup-match" }, { id: "fwd", match: { subject: "generic:*" }, via: ["agentpush"], do: "forward" }, { id: "tg", match: { subject: "telegram:*" }, via: ["local-gh"] }])
    expect(routes.map(r => r.id)).toEqual(["gh-default", "dup-match", "fwd", "tg"])
    expect(warnings).toHaveLength(1)
    const v = await validateSentinelRoutes(routes, readyAgentpush())
    expect(v).toEqual([
      'route "dup-match": same match as earlier route "gh-default", it never wins',
      'route "fwd": do "forward" without target.url',
      'route "tg": via provider "local-gh" does not declare scheme "telegram"',
    ])
  })
})

describe("shadow routing at the sentinel_watch call site", () => {
  const deps = (routes: SentinelRoute[], log: SentinelRouteLogLine[]) => ({
    store: createSentinelStore({ persist: false }),
    resolveProvider: readyAgentpush(),
    isSessionAlive: () => true,
    publicUrl: () => undefined,
    routing: routing(routes, log),
  })

  // Plan test 1, shadow form: enforce is accepted but NOT applied in this
  // release, so the provider stays the legacy agentpush and the route stamp
  // records that the router would pick local-gh.
  it("agentpush ready + gh-default (enforce): provider unchanged, route stamp says local-gh", async () => {
    const log: SentinelRouteLogLine[] = []
    const d = deps([{ ...GH_DEFAULT, mode: "enforce" }], log)
    const r = await createSentinelWatch(d, { subject: "github:o/r#1", sessionId: "sess_a" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sentinel.provider).toBe("agentpush")
    expect(r.sentinel.route).toEqual({
      rule: "gh-default",
      routed: "local-gh",
      legacy: "agentpush",
      applied: false,
      reason: 'config rule "gh-default" matched github:*, via local-gh',
    })
  })

  // Plan test 4: one routing line per decision, the provider stays legacy.
  it("shadow mode writes one routing line and keeps the legacy provider", async () => {
    const log: SentinelRouteLogLine[] = []
    const d = deps([GH_DEFAULT], log)
    const r = await createSentinelWatch(d, { prUrl: "https://github.com/o/r/pull/7", sessionId: "sess_a" })
    expect(r.ok && r.sentinel.provider).toBe("agentpush")
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ site: "watch", subject: "github:o/r#7", legacy: "agentpush", routed: "local-gh", rule: "gh-default", applied: false })
    expect(Object.keys(log[0]!).sort()).toEqual(["applied", "legacy", "reason", "routed", "rule", "site", "subject", "ts", "types"])
  })

  it("without routing wired, the sentinel carries no route and nothing is logged (old behaviour)", async () => {
    const store = createSentinelStore({ persist: false })
    const r = await createSentinelWatch({ store, resolveProvider: readyAgentpush(), isSessionAlive: () => true, publicUrl: () => undefined }, { subject: "github:o/r#1", sessionId: "sess_a" })
    expect(r.ok && r.sentinel.route).toBeUndefined()
  })

  it("a router failure never blocks the watch", async () => {
    const store = createSentinelStore({ persist: false })
    const r = await createSentinelWatch(
      {
        store,
        resolveProvider: readyAgentpush(),
        isSessionAlive: () => true,
        publicUrl: () => undefined,
        routing: { config: () => { throw new Error("config unreadable") } },
      },
      { subject: "github:o/r#1", sessionId: "sess_a" },
    )
    expect(r.ok && r.sentinel.provider).toBe("agentpush")
    expect(r.ok && r.sentinel.route).toBeUndefined()
  })
})

describe("sentinel_routes MCP tool", () => {
  type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  function tools(resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>, routes: SentinelRoute[]) {
    const handlers = new Map<string, Handler>()
    const server = { tool: (name: string, _d: string, _s: unknown, h: Handler) => void handlers.set(name, h) } as unknown as McpServer
    registerSentinelTools(server, {
      store: createSentinelStore({ persist: false }),
      runtime: { pollOnce: async () => {} },
      resolveProvider,
      isSessionAlive: () => true,
      routing: { config: () => ({ routes }), log: () => {} },
      publicUrl: () => undefined,
    })
    return async (input: Record<string, unknown>) => {
      const res = await handlers.get("sentinel_routes")!(input)
      return JSON.parse(res.content[0]!.text) as Record<string, unknown>
    }
  }

  // Plan test 5.
  it("explain telegram:x with agentpush unready and a refuse rule names the rule and the rejection", async () => {
    const call = tools(
      resolverOf({ agentpush: provider("agentpush", ["*"], NO_KEY), "local-gh": provider("local-gh", ["github"]) }),
      [{ id: "telegram", match: { subject: "telegram:*" }, via: ["agentpush"], fallback: "refuse", do: "deliver" }],
    )
    const out = await call({ explain: { subject: "telegram:x" } })
    expect(out.explain).toMatchObject({
      rule: "telegram",
      slug: null,
      error: "route_unavailable",
      walked: [{ provider: "agentpush", rejected: `unready: ${NO_KEY}`, durable: false }],
      applied: false,
    })
  })

  it("explain a github subject with no config rule: builtin:github picks local-gh while legacy is agentpush", async () => {
    const out = await tools(readyAgentpush(), [])({ explain: { subject: "github:agentproto/ts#1501" } })
    expect(out.explain).toMatchObject({
      subject: "github:agentproto/ts#1501",
      site: "watch",
      rule: "builtin:github",
      slug: "local-gh",
      legacy: "agentpush",
      applied: false,
      walked: [{ provider: "local-gh" }],
    })
  })

  it("explain a session subject: builtin:session picks session, same as legacy", async () => {
    const out = await tools(readyAgentpush(), [])({ explain: { subject: "session:sess_child" } })
    expect(out.explain).toMatchObject({ rule: "builtin:session", slug: "session", legacy: "session", walked: [{ provider: "session" }] })
  })

  it("list returns config rows then the visible builtin table, with provider readiness", async () => {
    const out = await tools(
      resolverOf({ agentpush: provider("agentpush", ["*"], NO_KEY), "local-gh": provider("local-gh", ["github"]) }),
      [GH_DEFAULT],
    )({})
    expect(out).toMatchObject({ mode: "shadow", configuredMode: "shadow", applied: false })
    expect((out.routes as Array<{ id: string; source: string }>).map(r => [r.id, r.source])).toEqual([
      ["gh-default", "config"],
      ["builtin:session", "builtin"],
      ["builtin:github", "builtin"],
      ["builtin:default", "builtin"],
    ])
    const providers = out.providers as Array<{ slug: string; ready: boolean; reason?: string }>
    expect(providers.find(p => p.slug === "agentpush")).toMatchObject({ ready: false, reason: `unready: ${NO_KEY}` })
    expect(providers.find(p => p.slug === "local-gh")).toMatchObject({ ready: true })
  })
})

describe("explainSentinelRoute legacy replay", () => {
  it("mcp-events is always local-gh and an explicit provider is echoed", async () => {
    const deps = { resolveProvider: readyAgentpush(), routes: [], publicUrl: () => undefined }
    expect((await explainSentinelRoute({ subject: "github:o/r#1", site: "mcp-events" }, deps)).legacy).toBe("local-gh")
    expect((await explainSentinelRoute({ subject: "github:o/r#1", site: "watch", provider: "local-gh" }, deps)).legacy).toBe("local-gh")
    expect((await explainSentinelRoute({ subject: "session:s", site: "http", targetKind: "webhook" }, deps)).legacy).toBe("agentpush")
  })
})
