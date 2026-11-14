/**
 * `daemon.frameAncestors`: validation table, config -> server option, and the
 * serve.ts wiring that hands the result to the gateway.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  resolveServeFrameAncestors,
  validateFrameAncestors,
} from "../commands/serve-frame-ancestors.js"

const accepted = (entry: string): string[] => validateFrameAncestors([entry]).accepted

describe("validateFrameAncestors", () => {
  it.each([
    ["https://web.telegram.org", "https://web.telegram.org"],
    ["https://x.example:8443", "https://x.example:8443"],
    ["vscode-webview:", "vscode-webview:"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["  https://web.telegram.org  ", "https://web.telegram.org"],
    ["HTTPS://Web.Telegram.org", "https://web.telegram.org"],
  ])("accepts %j as %j", (entry, expected) => {
    expect(accepted(entry)).toEqual([expected])
  })

  it.each([
    ["*"],
    ["https://*.telegram.org"],
    ["https:"],
    ["http:"],
    ["http://evil.example"],
    ["'self'"],
    ["'none'"],
    ["self"],
    ["https://a.example; script-src *"],
    ["https://a.example https://b.example"],
    ["https://a.example,https://b.example"],
    [""],
    ["   "],
    ["https://a.example/path"],
    ["https://a.example/"],
    ["https://a.example?x=1"],
    ["https://a.example#frag"],
    ["https://user:pw@a.example"],
    ["https://a.example\\@evil.example"],
    ["data:"],
    ["blob:"],
    ["ftp://a.example"],
    ["web.telegram.org"],
  ])("rejects %j", entry => {
    const { accepted: ok, rejected } = validateFrameAncestors([entry])
    expect(ok).toEqual([])
    expect(rejected).toHaveLength(1)
  })

  it("rejects non-string entries", () => {
    expect(validateFrameAncestors([42, null, {}]).accepted).toEqual([])
  })

  it("collapses duplicates, including ones that differ only in case or default port", () => {
    expect(
      validateFrameAncestors([
        "https://web.telegram.org",
        "https://WEB.telegram.org",
        "https://web.telegram.org:443",
      ]).accepted,
    ).toEqual(["https://web.telegram.org"])
  })
})

describe("resolveServeFrameAncestors", () => {
  const collect = () => {
    const lines: string[] = []
    return { lines, warn: (line: string) => lines.push(line) }
  }

  it("turns the config list into the server option", () => {
    const { lines, warn } = collect()
    expect(resolveServeFrameAncestors(["https://web.telegram.org"], warn)).toEqual([
      "https://web.telegram.org",
    ])
    expect(lines).toEqual([])
  })

  it("returns undefined when the key is absent, so the defaults stay untouched", () => {
    const { lines, warn } = collect()
    expect(resolveServeFrameAncestors(undefined, warn)).toBeUndefined()
    expect(resolveServeFrameAncestors([], warn)).toBeUndefined()
    expect(lines).toEqual([])
  })

  it("reads a bare string as a comma-separated list", () => {
    const { warn } = collect()
    expect(resolveServeFrameAncestors("https://web.telegram.org", warn)).toEqual([
      "https://web.telegram.org",
    ])
    expect(
      resolveServeFrameAncestors(
        "https://web.telegram.org,https://webk.telegram.org,https://webz.telegram.org",
        warn,
      ),
    ).toEqual([
      "https://web.telegram.org",
      "https://webk.telegram.org",
      "https://webz.telegram.org",
    ])
  })

  it("drops a bad entry with one warning naming only that entry, keeping the good ones", () => {
    const { lines, warn } = collect()
    const out = resolveServeFrameAncestors(
      ["https://web.telegram.org", "*", "https://webk.telegram.org"],
      warn,
    )
    expect(out).toEqual(["https://web.telegram.org", "https://webk.telegram.org"])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"*"')
    expect(lines[0]).not.toContain("web.telegram.org")
    expect(lines[0]!.trimEnd().split("\n")).toHaveLength(1)
  })

  it("never widens: a list of only bad entries yields undefined", () => {
    const { lines, warn } = collect()
    expect(resolveServeFrameAncestors(["*", "https:", "http://evil.example"], warn)).toBeUndefined()
    expect(lines).toHaveLength(3)
  })

  it("keeps a hostile entry on one log line", () => {
    const { lines, warn } = collect()
    resolveServeFrameAncestors(["https://a.example\nfake: log line"], warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.trimEnd()).not.toContain("\n")
  })

  it("ignores a value that is neither a list nor a string, with one warning", () => {
    const { lines, warn } = collect()
    expect(resolveServeFrameAncestors(42, warn)).toBeUndefined()
    expect(lines).toHaveLength(1)
  })
})

describe("serve.ts wiring", () => {
  const text = readFileSync(new URL("../commands/serve.ts", import.meta.url), "utf8")

  it("reads daemon.frameAncestors and puts the result in ServeOpts", () => {
    expect(text).toContain("resolveServeFrameAncestors(\n    cfgDaemon.frameAncestors,")
    expect(text).toContain("...(frameAncestors ? { frameAncestors } : {}),")
  })

  it("hands ServeOpts.frameAncestors to the gateway", () => {
    expect(text).toContain(
      "...(opts.frameAncestors ? { frameAncestors: opts.frameAncestors } : {}),",
    )
  })
})
