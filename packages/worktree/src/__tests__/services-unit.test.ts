import { describe, it, expect } from "vitest"
import { slugify, serviceHostname, serviceUrl } from "../services/slug.js"
import { isPortFree, ephemeralPort, allocatePort } from "../services/ports.js"
import { ProxyTable, stripPort } from "../services/proxy-table.js"
import { peerEnv, peerEnvKey, serviceEnvToken, serviceEnv, ENV_VARS } from "../env.js"

describe("slugify + hostname derivation", () => {
  it("lowercases, collapses non-alphanumerics, trims", () => {
    expect(slugify("Fix Flaky_Test!!")).toBe("fix-flaky-test")
    expect(slugify("wt/fix--thing")).toBe("wt-fix-thing")
    expect(slugify("--Edge--")).toBe("edge")
  })

  it("includes the branch label off the default branch", () => {
    const host = serviceHostname({
      script: "web",
      branch: "wt/fix-flaky",
      repo: "My Repo",
      isDefaultBranch: false,
    })
    expect(host).toBe("web--wt-fix-flaky--my-repo.localhost")
  })

  it("drops the branch label on the default branch", () => {
    const host = serviceHostname({
      script: "web",
      branch: "main",
      repo: "my-repo",
      isDefaultBranch: true,
    })
    expect(host).toBe("web--my-repo.localhost")
  })

  it("builds a full proxy URL with the proxy port", () => {
    expect(
      serviceUrl({ script: "api", branch: "main", repo: "app", isDefaultBranch: true }, 18780),
    ).toBe("http://api--app.localhost:18780")
  })
})

describe("port allocation", () => {
  it("uses a declared port when it is free", async () => {
    const free = await ephemeralPort()
    expect(await allocatePort(free)).toBe(free)
  })

  it("falls back to an ephemeral port when the declared one is occupied", async () => {
    // Occupy a port by keeping a listener open, then reserve it.
    const busy = await ephemeralPort()
    const reserved = new Set([busy])
    const allocated = await allocatePort(busy, reserved)
    expect(allocated).not.toBe(busy)
    expect(await isPortFree(allocated)).toBe(true)
  })

  it("never hands out a reserved port", async () => {
    const seen = new Set<number>()
    for (let i = 0; i < 5; i++) {
      const port = await allocatePort(undefined, seen)
      expect(seen.has(port)).toBe(false)
      seen.add(port)
    }
  })
})

describe("peer env computation", () => {
  it("upper-cases + tokenises service names", () => {
    expect(serviceEnvToken("web-api")).toBe("WEB_API")
    expect(serviceEnvToken("my.svc 2")).toBe("MY_SVC_2")
    expect(peerEnvKey("web", "PORT")).toBe("AGENTPROTO_SERVICE_WEB_PORT")
  })

  it("emits PORT + URL for each peer", () => {
    const env = peerEnv([
      { name: "web", port: 3000, url: "http://web.localhost:18780" },
      { name: "api", port: 4000, url: "http://api.localhost:18780" },
    ])
    expect(env).toEqual({
      AGENTPROTO_SERVICE_WEB_PORT: "3000",
      AGENTPROTO_SERVICE_WEB_URL: "http://web.localhost:18780",
      AGENTPROTO_SERVICE_API_PORT: "4000",
      AGENTPROTO_SERVICE_API_URL: "http://api.localhost:18780",
    })
  })

  it("serviceEnv combines context, self, and peers", () => {
    const env = serviceEnv({
      ctx: { sourceCheckoutPath: "/src", worktreePath: "/wt", branchName: "wt/x" },
      self: { name: "web", port: 3000, url: "http://web/" },
      peers: [{ name: "api", port: 4000, url: "http://api/" }],
    })
    expect(env[ENV_VARS.port]).toBe("3000")
    expect(env[ENV_VARS.url]).toBe("http://web/")
    expect(env[ENV_VARS.sourceCheckoutPath]).toBe("/src")
    expect(env.AGENTPROTO_SERVICE_API_PORT).toBe("4000")
  })
})

describe("ProxyTable routing", () => {
  it("routes by exact host and strips the port from the Host header", () => {
    const table = new ProxyTable()
    table.set("web--repo.localhost", 3000)
    expect(table.lookup("web--repo.localhost")).toBe(3000)
    expect(table.lookup("web--repo.localhost:18780")).toBe(3000)
    expect(table.lookup("WEB--REPO.localhost:18780")).toBe(3000)
    expect(table.lookup("nope.localhost")).toBeUndefined()
    expect(table.lookup(undefined)).toBeUndefined()
  })

  it("delete removes a route", () => {
    const table = new ProxyTable()
    table.set("a.localhost", 1)
    expect(table.delete("a.localhost")).toBe(true)
    expect(table.get("a.localhost")).toBeUndefined()
    expect(table.size).toBe(0)
  })

  it("stripPort handles ipv6 and missing ports", () => {
    expect(stripPort("host:8080")).toBe("host")
    expect(stripPort("host")).toBe("host")
    expect(stripPort("[::1]:8080")).toBe("[::1]")
  })
})
