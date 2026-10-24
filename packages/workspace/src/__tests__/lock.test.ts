import { describe, it, expect } from "vitest"
import { parseLock, writeLock } from "../lock.js"

describe("agentproto.lock round-trip", () => {
  it("writes and parses back the same lock, applying apps/packs defaults", () => {
    const yaml = writeLock({
      lockfile: "agentproto-lock/v1",
      generated: "2026-10-17T18:00:00Z",
    })
    expect(yaml).toContain("lockfile: agentproto-lock/v1")
    const parsed = parseLock(yaml)
    expect(parsed.apps).toEqual([])
    expect(parsed.packs).toEqual([])
  })

  it("round-trips a populated lock", () => {
    const yaml = writeLock({
      lockfile: "agentproto-lock/v1",
      generated: "2026-10-17T18:00:00Z",
      apps: [
        {
          id: "@agentik/seo-crew",
          version: "0.1.0",
          source: "file:/path/to/seo-crew",
          sha256: "a".repeat(64),
          attach: "@jeremy/chatcommerce",
          dataDir: "agentik/chatcommerce/.apps/seo-crew",
        },
      ],
      packs: [
        {
          name: "@pygmalion/staff",
          version: "0.1.0",
          digest: "agentproto-pack-digest/v1:deadbeef",
          attach: "@jeremy/root",
        },
      ],
    })
    const parsed = parseLock(yaml)
    expect(parsed.apps).toHaveLength(1)
    expect(parsed.apps[0]?.attach).toBe("@jeremy/chatcommerce")
    expect(parsed.packs[0]?.digest).toBe("agentproto-pack-digest/v1:deadbeef")
  })

  it("parses the canonical workspace.lock/v1 and review.pack-digest/v1 tags", () => {
    const yaml = `lockfile: workspace.lock/v1
generated: 2026-10-17T18:00:00Z
packs:
  - name: "@pygmalion/staff"
    version: 0.1.0
    digest: "review.pack-digest/v1:deadbeef"
    attach: "@jeremy/root"
`
    const parsed = parseLock(yaml)
    expect(parsed.lockfile).toBe("workspace.lock/v1")
    expect(parsed.packs[0]?.digest).toBe("review.pack-digest/v1:deadbeef")
  })

  it("still parses the legacy tags", () => {
    const yaml = writeLock({ lockfile: "agentproto-lock/v1", generated: "2026-10-17T18:00:00Z" })
    expect(parseLock(yaml).lockfile).toBe("agentproto-lock/v1")
  })

  it("keeps writing the legacy tags when handed the canonical ones", () => {
    const yaml = writeLock({
      lockfile: "workspace.lock/v1",
      generated: "2026-10-17T18:00:00Z",
      packs: [{ name: "@p/p", version: "0.1.0", digest: "review.pack-digest/v1:deadbeef", attach: "@p/root" }],
    })
    expect(yaml).toContain("lockfile: agentproto-lock/v1")
    expect(yaml).toContain("digest: agentproto-pack-digest/v1:deadbeef")
  })

  it("rejects a malformed sha256", () => {
    expect(() =>
      writeLock({
        lockfile: "agentproto-lock/v1",
        generated: "2026-10-17T18:00:00Z",
        apps: [
          {
            id: "@agentik/seo-crew",
            version: "0.1.0",
            sha256: "not-a-hash",
            attach: "@jeremy/chatcommerce",
            dataDir: "x",
          },
        ],
      }),
    ).toThrow()
  })

  it("parseLock rejects the wrong lockfile literal", () => {
    expect(() => parseLock("lockfile: agentproto-lock/v2\ngenerated: 2026-10-17T18:00:00Z\n")).toThrow(
      /parseLock/,
    )
  })
})
