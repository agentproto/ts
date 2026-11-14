import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PUBLIC_BASE_HEADER,
  resolvePublicAppOrigins,
  resolvePublicBase,
  resolveRequestHttpBaseUrl,
  signPublicBase,
} from "../public-origins.js"

describe("resolveRequestHttpBaseUrl", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("prefers the configured public HTTP origin and trims trailing slashes", () => {
    vi.stubEnv("AGENTPROTO_PUBLIC_HTTP_ORIGIN", " https://apps.example.test/// ")
    expect(
      resolveRequestHttpBaseUrl({
        host: "127.0.0.1:18790",
        "x-forwarded-proto": "http",
      }),
    ).toBe("https://apps.example.test")
  })

  it("uses the first comma-separated forwarded protocol", () => {
    expect(
      resolveRequestHttpBaseUrl({
        host: "apps.example.test",
        "x-forwarded-proto": " https, http ",
      }),
    ).toBe("https://apps.example.test")
  })

  it("uses the first forwarded protocol when Node exposes an array", () => {
    expect(
      resolveRequestHttpBaseUrl({
        host: "apps.example.test",
        "x-forwarded-proto": ["https", "http"],
      }),
    ).toBe("https://apps.example.test")
  })

  it("falls back to the request host when the configured origin is invalid", () => {
    expect(
      resolveRequestHttpBaseUrl(
        { host: "127.0.0.1:18790" },
        "javascript:alert(1)",
      ),
    ).toBe("http://127.0.0.1:18790")
  })

  it("uses X-Forwarded-Host ahead of the rewritten request host", () => {
    expect(
      resolveRequestHttpBaseUrl({
        host: "127.0.0.1:18790",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "abc.trycloudflare.com",
      }),
    ).toBe("https://abc.trycloudflare.com")
  })

  it("uses the first X-Forwarded-Host when Node exposes an array", () => {
    expect(
      resolveRequestHttpBaseUrl({
        host: "127.0.0.1:18790",
        "x-forwarded-proto": "https",
        "x-forwarded-host": ["abc.trycloudflare.com", "other"],
      }),
    ).toBe("https://abc.trycloudflare.com")
  })

  it("takes the first comma-separated forwarded host", () => {
    expect(
      resolveRequestHttpBaseUrl({
        host: "127.0.0.1:18790",
        "x-forwarded-proto": "https",
        "x-forwarded-host": " abc.trycloudflare.com , other",
      }),
    ).toBe("https://abc.trycloudflare.com")
  })

  it("falls back to the request host when the forwarded host is invalid", () => {
    expect(
      resolveRequestHttpBaseUrl({
        host: "127.0.0.1:18790",
        "x-forwarded-host": "evil.test/path",
      }),
    ).toBe("http://127.0.0.1:18790")
    expect(
      resolveRequestHttpBaseUrl({
        host: "127.0.0.1:18790",
        "x-forwarded-host": "user@evil.test",
      }),
    ).toBe("http://127.0.0.1:18790")
  })

  it("lets the configured origin beat X-Forwarded-Host", () => {
    vi.stubEnv("AGENTPROTO_PUBLIC_HTTP_ORIGIN", "https://apps.example.test")
    expect(
      resolveRequestHttpBaseUrl({
        host: "127.0.0.1:18790",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "abc.trycloudflare.com",
      }),
    ).toBe("https://apps.example.test")
  })
})

describe("resolvePublicBase", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("defaults to https for a public X-Forwarded-Host that carries no X-Forwarded-Proto", () => {
    expect(
      resolvePublicBase({
        host: "127.0.0.1:18790",
        "x-forwarded-host": "abc.trycloudflare.com",
      }).baseUrl,
    ).toBe("https://abc.trycloudflare.com")
  })

  it("keeps http for a forwarded host that is loopback, an IP literal or a single label", () => {
    for (const host of ["localhost:3000", "app.localhost", "10.0.0.5:8080", "[::1]:8080", "daemon:8080"]) {
      expect(resolvePublicBase({ host: "127.0.0.1:18790", "x-forwarded-host": host }).baseUrl).toBe(
        `http://${host}`,
      )
    }
  })

  it("lets an explicit X-Forwarded-Proto: http beat the https default", () => {
    expect(
      resolvePublicBase({
        host: "127.0.0.1:18790",
        "x-forwarded-host": "abc.example.test",
        "x-forwarded-proto": "http",
      }).baseUrl,
    ).toBe("http://abc.example.test")
  })

  it("honors a daemon-signed public base header, path prefix included", () => {
    const base = resolvePublicBase({
      host: "127.0.0.1:18790",
      [PUBLIC_BASE_HEADER]: signPublicBase("https://fp.agentproto.cloud/d/fp/"),
    })
    expect(base).toMatchObject({
      origin: "https://fp.agentproto.cloud",
      pathPrefix: "/d/fp",
      baseUrl: "https://fp.agentproto.cloud/d/fp",
      source: "trusted-header",
    })
  })

  it("ranks env > trusted header > forwarded headers > Host", () => {
    const headers = {
      host: "10.1.2.3:18790",
      "x-forwarded-host": "fwd.example.test",
      [PUBLIC_BASE_HEADER]: signPublicBase("https://trusted.example.test/d/x"),
    }
    expect(resolvePublicBase(headers).baseUrl).toBe("https://trusted.example.test/d/x")
    expect(resolvePublicBase(headers, "https://env.example.test").baseUrl).toBe("https://env.example.test")
    const { [PUBLIC_BASE_HEADER]: _ignored, ...noTrusted } = headers
    expect(resolvePublicBase(noTrusted).baseUrl).toBe("https://fwd.example.test")
    expect(resolvePublicBase({ host: "10.1.2.3:18790" }).baseUrl).toBe("http://10.1.2.3:18790")
  })

  it("ignores an unsigned, tampered or foreign-signed public base header", () => {
    const good = signPublicBase("https://trusted.example.test/d/x")
    const [payload] = good.split(".")
    const forged = Buffer.from("https://evil.example.test/d/x").toString("base64url")
    for (const value of [
      "https://evil.example.test/d/x",
      `${forged}.${good.split(".")[1]}`,
      `${payload}.AAAA`,
      "garbage",
      "",
    ]) {
      expect(
        resolvePublicBase({ host: "127.0.0.1:18790", [PUBLIC_BASE_HEADER]: value }),
      ).toMatchObject({ baseUrl: "http://127.0.0.1:18790", source: "loopback" })
    }
  })

  it("accepts a path prefix on the configured origin", () => {
    vi.stubEnv("AGENTPROTO_PUBLIC_HTTP_ORIGIN", "https://apps.example.test/agentproto/")
    expect(resolvePublicBase({ host: "127.0.0.1:18790" })).toMatchObject({
      origin: "https://apps.example.test",
      pathPrefix: "/agentproto",
      baseUrl: "https://apps.example.test/agentproto",
      source: "env",
    })
  })

  it("rejects a prefix carrying a query, fragment or credentials", () => {
    for (const bad of ["https://a.test/p?x=1", "https://a.test/p#f", "https://u:p@a.test/p"]) {
      expect(resolvePublicBase({ host: "127.0.0.1:18790" }, bad).source).toBe("loopback")
    }
  })
})

describe("resolvePublicAppOrigins", () => {
  it("derives wss from a configured https origin", () => {
    expect(resolvePublicAppOrigins(18790, "https://apps.example.test/")).toEqual({
      httpOrigin: "https://apps.example.test",
      wsOrigin: "wss://apps.example.test",
    })
  })

  it("lets the explicit WebSocket origin override the derived value", () => {
    expect(
      resolvePublicAppOrigins(
        18790,
        "https://apps.example.test",
        " wss://pty.example.test/// ",
      ),
    ).toEqual({
      httpOrigin: "https://apps.example.test",
      wsOrigin: "wss://pty.example.test",
    })
  })

  it("falls back to loopback HTTP and WS origins", () => {
    expect(resolvePublicAppOrigins(19000, "", "")).toEqual({
      httpOrigin: "http://127.0.0.1:19000",
      wsOrigin: "ws://127.0.0.1:19000",
    })
  })
})
