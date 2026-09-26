import { afterEach, describe, expect, it, vi } from "vitest"
import {
  resolvePublicAppOrigins,
  resolveRequestHttpBaseUrl,
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
