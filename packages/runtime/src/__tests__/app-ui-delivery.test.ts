import { describe, expect, it } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"

import {
  appUiContentType,
  createRepresentationCache,
  createEncodedRepresentation,
  ifNoneMatchHits,
  isCompressibleContentType,
  isValidAppUiAssetName,
  negotiateContentEncoding,
  sendRepresentation,
  strongEtag,
} from "../app-ui-delivery.js"

describe("app-ui-delivery", () => {
  it("negotiates br, then gzip, then identity, honouring q=0 and *", () => {
    expect(negotiateContentEncoding("gzip, deflate, br, zstd")).toBe("br")
    expect(negotiateContentEncoding("gzip")).toBe("gzip")
    expect(negotiateContentEncoding("x-gzip")).toBe("gzip")
    expect(negotiateContentEncoding("br;q=0, gzip;q=0.5")).toBe("gzip")
    expect(negotiateContentEncoding("*")).toBe("br")
    expect(negotiateContentEncoding("*, br;q=0")).toBe("gzip")
    expect(negotiateContentEncoding("*;q=0")).toBe("identity")
    expect(negotiateContentEncoding("identity")).toBe("identity")
    expect(negotiateContentEncoding("")).toBe("identity")
    expect(negotiateContentEncoding(undefined)).toBe("identity")
  })

  it("matches if-none-match lists, * and weak spellings against a strong etag", () => {
    const etag = strongEtag("hello")
    expect(ifNoneMatchHits(etag, etag)).toBe(true)
    expect(ifNoneMatchHits(`"other", ${etag}`, etag)).toBe(true)
    expect(ifNoneMatchHits(`W/${etag}`, etag)).toBe(true)
    expect(ifNoneMatchHits("*", etag)).toBe(true)
    expect(ifNoneMatchHits('"other"', etag)).toBe(false)
    expect(ifNoneMatchHits(undefined, etag)).toBe(false)
    expect(strongEtag("hello", "embed")).not.toBe(etag)
  })

  it("validates asset names as flat, non-dot-leading [A-Za-z0-9._-]", () => {
    for (const ok of ["index-Bx9_a.js", "a.b.c.css", "font.woff2", "x"]) expect(isValidAppUiAssetName(ok), ok).toBe(true)
    for (const bad of ["", ".", "..", ".env", "a/b", "a\\b", "%2e%2e", "a b.js", "a?b"]) {
      expect(isValidAppUiAssetName(bad), bad).toBe(false)
    }
  })

  it("maps content types and compressibility by extension", () => {
    expect(appUiContentType(".JS")).toBe("text/javascript; charset=utf-8")
    expect(appUiContentType("css")).toBe("text/css; charset=utf-8")
    expect(appUiContentType(".map")).toBe("application/json; charset=utf-8")
    expect(appUiContentType(".bin")).toBe("application/octet-stream")
    expect(isCompressibleContentType(appUiContentType(".svg"))).toBe(true)
    expect(isCompressibleContentType(appUiContentType(".woff2"))).toBe(false)
    expect(isCompressibleContentType(appUiContentType(".png"))).toBe(false)
  })

  it("caches by key + stamp, rebuilds on a stamp change, evicts least-recently-used", async () => {
    const cache = createRepresentationCache(2)
    let builds = 0
    const build = (text: string) => () => {
      builds += 1
      return createEncodedRepresentation(Buffer.from(text), { compressible: true })
    }
    const a1 = await cache.get("a", "1", build("a"))
    expect(await cache.get("a", "1", build("a"))).toBe(a1)
    expect(builds).toBe(1)
    const a2 = await cache.get("a", "2", build("a2"))
    expect(a2).not.toBe(a1)
    expect(builds).toBe(2)
    await cache.get("b", "1", build("b"))
    await cache.get("a", "2", build("a2")) // touch a
    await cache.get("c", "1", build("c")) // evicts b
    expect(cache.size).toBe(2)
    await cache.get("b", "1", build("b"))
    expect(builds).toBe(5)
  })

  it("merges vary into an existing Vary (CORS's Origin) instead of replacing it", () => {
    const rep = createEncodedRepresentation(Buffer.from("x"), { compressible: true })
    for (const [prior, expected] of [
      [undefined, "accept-encoding"],
      ["Origin", "Origin, accept-encoding"],
      ["Origin, Accept-Encoding", "Origin, Accept-Encoding"],
    ] as const) {
      let written: Record<string, string> = {}
      const res = {
        getHeader: () => prior,
        writeHead: (_status: number, headers: Record<string, string>) => {
          written = headers
        },
        end: () => {},
      } as unknown as ServerResponse
      sendRepresentation({ headers: {}, method: "GET" } as IncomingMessage, res, rep, {})
      expect(written.vary).toBe(expected)
    }
  })
})
