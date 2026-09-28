/**
 * `resolveProxyDialOptions` — proxy selection for the daemon's rendezvous
 * dial (DEVICES-PLAN item 3). Every case injects `env` rather than mutating
 * `process.env`, since the helper takes it as a parameter for exactly this.
 */

import { describe, it, expect } from "vitest"
import { HttpsProxyAgent } from "https-proxy-agent"
import { HttpProxyAgent } from "http-proxy-agent"
import { resolveProxyDialOptions } from "../proxy-dial.js"

describe("resolveProxyDialOptions", () => {
  it("nothing set dials direct", () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {})
    expect(result).toEqual({ via: "direct" })
    expect(result.agent).toBeUndefined()
  })

  it("HTTPS_PROXY set + a wss:// target selects an HttpsProxyAgent", () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
    })
    expect(result.via).toBe("proxy")
    expect(result.agent).toBeInstanceOf(HttpsProxyAgent)
  })

  it("lowercase https_proxy is honoured too", () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {
      https_proxy: "http://proxy.corp.example:8080",
    })
    expect(result.via).toBe("proxy")
    expect(result.agent).toBeInstanceOf(HttpsProxyAgent)
  })

  it("HTTP_PROXY set + a ws:// target selects an HttpProxyAgent", () => {
    const result = resolveProxyDialOptions("ws://rdv.internal/v1", {
      HTTP_PROXY: "http://proxy.corp.example:8080",
    })
    expect(result.via).toBe("proxy")
    expect(result.agent).toBeInstanceOf(HttpProxyAgent)
  })

  it("a ws:// target falls back to HTTPS_PROXY when HTTP_PROXY is unset", () => {
    const result = resolveProxyDialOptions("ws://rdv.internal/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
    })
    expect(result.via).toBe("proxy")
    expect(result.agent).toBeInstanceOf(HttpProxyAgent)
  })

  it("NO_PROXY exact host match beats HTTPS_PROXY", () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "rdv.agentproto.sh",
    })
    expect(result).toEqual({ via: "direct" })
  })

  it("NO_PROXY suffix match (.suffix form) beats HTTPS_PROXY", () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: ".agentproto.sh",
    })
    expect(result).toEqual({ via: "direct" })
  })

  it("NO_PROXY suffix match (bare suffix form) beats HTTPS_PROXY", () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "agentproto.sh",
    })
    expect(result).toEqual({ via: "direct" })
  })

  it("NO_PROXY matching is case-insensitive", () => {
    const result = resolveProxyDialOptions("wss://RDV.agentproto.sh/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "RDV.AGENTPROTO.SH",
    })
    expect(result).toEqual({ via: "direct" })
  })

  it("NO_PROXY with an unrelated host doesn't suppress the proxy", () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "example.com,internal.corp",
    })
    expect(result.via).toBe("proxy")
  })

  it('NO_PROXY="*" disables proxying for every host', () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "*",
    })
    expect(result).toEqual({ via: "direct" })
  })

  it("a NO_PROXY entry with a port only matches that port", () => {
    const noMatch = resolveProxyDialOptions("wss://rdv.agentproto.sh:9443/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "rdv.agentproto.sh:443",
    })
    expect(noMatch.via).toBe("proxy")

    const match = resolveProxyDialOptions("wss://rdv.agentproto.sh:9443/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "rdv.agentproto.sh:9443",
    })
    expect(match).toEqual({ via: "direct" })
  })

  it("lowercase no_proxy is honoured too", () => {
    const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1", {
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      no_proxy: "rdv.agentproto.sh",
    })
    expect(result).toEqual({ via: "direct" })
  })

  it("defaults to process.env when no env is injected", () => {
    const prev = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = "http://proxy.corp.example:8080"
    try {
      const result = resolveProxyDialOptions("wss://rdv.agentproto.sh/v1")
      expect(result.via).toBe("proxy")
    } finally {
      if (prev === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = prev
    }
  })
})
