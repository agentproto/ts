import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AcpMcpServer } from "@agentproto/acp"

import type { AllowlistEntry } from "../command-allowlist.js"
import {
  DEFAULT_STDIO_MOUNT_GATE_MODE,
  decideStdioMount,
  recordStdioMount,
  resetStdioMountObservations,
  stdioMountReport,
  stdioMountRequests,
} from "../stdio-mount-gate.js"

const server = (entry: Partial<AcpMcpServer> & Pick<AcpMcpServer, "name" | "transport">): AcpMcpServer =>
  entry as AcpMcpServer

describe("stdio mount gate mode", () => {
  it("defaults to observe", () => {
    expect(DEFAULT_STDIO_MOUNT_GATE_MODE).toBe("observe")
  })
})

describe("stdioMountRequests", () => {
  it("keeps stdio entries only, in order, with args defaulting to []", () => {
    const requests = stdioMountRequests([
      server({ name: "http-one", transport: "http", ref: "https://example.test/mcp" }),
      server({ name: "node", transport: "stdio", ref: "/usr/local/bin/node", args: ["server.js"] }),
      server({ name: "sse-one", transport: "sse", ref: "https://example.test/sse" }),
      server({ name: "npx", transport: "stdio", ref: "npx", env: { K: "V" } }),
    ])
    expect(requests).toEqual([
      { name: "node", command: "node", args: ["server.js"] },
      { name: "npx", command: "npx", args: [] },
    ])
  })

  it("is empty for an absent list or one with no stdio entry", () => {
    expect(stdioMountRequests(undefined)).toEqual([])
    expect(stdioMountRequests([])).toEqual([])
    expect(
      stdioMountRequests([server({ name: "http-one", transport: "http", ref: "https://example.test/mcp" })]),
    ).toEqual([])
  })

  it("takes the basename of a path ref", () => {
    expect(
      stdioMountRequests([server({ name: "x", transport: "stdio", ref: "/opt/bin/node" })]),
    ).toEqual([{ name: "x", command: "node", args: [] }])
  })
})

describe("decideStdioMount", () => {
  const requested = [{ name: "x", command: "evil", args: ["--token", "S3CRET-ARG"] }]
  const allowlist: AllowlistEntry[] = [{ command: "node" }]

  it("no caller id is no_caller", () => {
    expect(
      decideStdioMount({
        callerSessionId: undefined,
        callerKnown: false,
        requested,
        allowlist,
      }),
    ).toEqual({ verdict: "no_caller", denied: [] })
  })

  it("a trusted but unknown caller is caller_unknown", () => {
    expect(
      decideStdioMount({
        callerSessionId: "ghost",
        callerKnown: false,
        requested,
        allowlist,
      }),
    ).toEqual({ verdict: "caller_unknown", denied: [] })
  })

  it("an external caller is external, never denied", () => {
    expect(
      decideStdioMount({
        callerSessionId: "desk",
        callerKnown: true,
        callerExternal: true,
        requested,
        allowlist,
      }),
    ).toEqual({ verdict: "external", denied: [] })
  })

  it("nothing requested is none (even when sandboxed)", () => {
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        requested: [],
        allowlist,
      }),
    ).toEqual({ verdict: "none", denied: [] })
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        sandboxed: true,
        requested: [],
        allowlist,
      }),
    ).toEqual({ verdict: "none", denied: [] })
  })

  it("a sandboxed spawn is sandboxed", () => {
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        sandboxed: true,
        requested,
        allowlist,
      }),
    ).toEqual({ verdict: "sandboxed", denied: [] })
  })

  it("every requested mount admitted is allowed", () => {
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        requested: [
          { name: "a", command: "node", args: ["server.js"] },
          { name: "b", command: "npx", args: [] },
        ],
        allowlist: [{ command: "node" }, { command: "npx" }],
      }),
    ).toEqual({ verdict: "allowed", denied: [] })
  })

  it("one outside the allowlist is would_deny with only that request, request order", () => {
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        requested: [
          { name: "bad", command: "evil", args: [] },
          { name: "good", command: "node", args: ["server.js"] },
          { name: "also-bad", command: "curl", args: [] },
        ],
        allowlist: [{ command: "node" }],
      }),
    ).toEqual({
      verdict: "would_deny",
      denied: [
        { name: "bad", command: "evil", args: [] },
        { name: "also-bad", command: "curl", args: [] },
      ],
    })
  })

  it("a plain entry admits any args", () => {
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        requested: [{ name: "x", command: "node", args: ["-e", "anything"] }],
        allowlist: [{ command: "node" }],
      }).verdict,
    ).toBe("allowed")
  })

  it("a constrained entry admits the argv prefix and refuses another", () => {
    const constrained: AllowlistEntry[] = [{ command: "node", args: ["server.js"] }]
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        requested: [{ name: "x", command: "node", args: ["server.js", "--x"] }],
        allowlist: constrained,
      }).verdict,
    ).toBe("allowed")
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        requested: [{ name: "x", command: "node", args: ["-e", "x"] }],
        allowlist: constrained,
      }).verdict,
    ).toBe("would_deny")
  })

  it("a path ref basename is admitted by a basename entry", () => {
    expect(
      decideStdioMount({
        callerSessionId: "caller",
        callerKnown: true,
        requested: [{ name: "x", command: "node", args: [] }],
        allowlist: [{ command: "node" }],
      }).verdict,
    ).toBe("allowed")
  })
})

describe("stdio mount observer", () => {
  beforeEach(() => {
    resetStdioMountObservations()
  })

  afterEach(() => {
    resetStdioMountObservations()
    vi.restoreAllMocks()
  })

  it("counts per verdict", () => {
    for (const verdict of [
      "allowed",
      "would_deny",
      "none",
      "no_caller",
      "caller_unknown",
      "external",
      "sandboxed",
    ] as const) {
      recordStdioMount(verdict, {
        mode: "observe",
        denied: verdict === "would_deny" ? [{ name: "x", command: "evil", args: [] }] : [],
        surface: "mcp",
      })
    }
    expect(stdioMountReport("observe").counts).toEqual({
      allowed: 1,
      would_deny: 1,
      none: 1,
      no_caller: 1,
      caller_unknown: 1,
      external: 1,
      sandboxed: 1,
    })
  })

  it("warns once per command across two occurrences", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const denied = [{ name: "x", command: "evil", args: ["--token", "S3CRET-ARG"] }]
    recordStdioMount("would_deny", { mode: "observe", denied, surface: "mcp" })
    recordStdioMount("would_deny", { mode: "observe", denied, surface: "mcp" })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("evil")
    expect(warn.mock.calls[0]?.[0]).not.toContain("S3CRET-ARG")
  })

  it("sorts would-deny rows by count, most frequent first", () => {
    recordStdioMount("would_deny", {
      mode: "observe",
      denied: [{ name: "one", command: "once", args: [] }],
      surface: "mcp",
    })
    for (let i = 0; i < 2; i++) {
      recordStdioMount("would_deny", {
        mode: "observe",
        denied: [{ name: "two", command: "twice", args: [] }],
        surface: "mcp",
      })
    }
    expect(stdioMountReport("observe").wouldDeny.map(r => [r.command, r.count])).toEqual([
      ["twice", 2],
      ["once", 1],
    ])
  })

  it("caps tracked rows at 200 while still counting, and reports at most 50", () => {
    for (let i = 0; i < 201; i++) {
      recordStdioMount("would_deny", {
        mode: "observe",
        denied: [{ name: `n${i}`, command: `cmd-${i}`, args: [] }],
        surface: "mcp",
      })
    }
    const report = stdioMountReport("observe")
    expect(report.counts.would_deny).toBe(201)
    expect(report.wouldDeny).toHaveLength(50)
  })

  it("reset forgets every observation", () => {
    recordStdioMount("would_deny", {
      mode: "observe",
      denied: [{ name: "x", command: "evil", args: [] }],
      surface: "mcp",
    })
    resetStdioMountObservations()
    expect(stdioMountReport("observe")).toMatchObject({
      counts: {
        allowed: 0,
        would_deny: 0,
        none: 0,
        no_caller: 0,
        caller_unknown: 0,
        external: 0,
        sandboxed: 0,
      },
      wouldDeny: [],
    })
  })

  it("never leaks args or env values into the warn text or the report rows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const requests = stdioMountRequests([
      server({
        name: "x",
        transport: "stdio",
        ref: "/opt/bin/evil",
        args: ["--token", "S3CRET-ARG"],
        env: { K: "S3CRET-ENV" },
      }),
    ])
    const decision = decideStdioMount({
      callerSessionId: "caller",
      callerKnown: true,
      requested: requests,
      allowlist: [],
    })
    recordStdioMount(decision.verdict, {
      mode: "observe",
      denied: decision.denied,
      surface: "mcp",
    })
    const serialized = JSON.stringify({
      warn: warn.mock.calls.map(call => call.map(String)),
      report: stdioMountReport("observe"),
    })
    expect(serialized).not.toContain("S3CRET-ARG")
    expect(serialized).not.toContain("S3CRET-ENV")
    expect(serialized).not.toContain("/opt/bin/evil")
  })
})
