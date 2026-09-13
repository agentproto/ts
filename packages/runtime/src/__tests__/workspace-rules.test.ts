/**
 * Unit coverage for `workspace-rules.ts` (WP-R4) — the pure per-workspace
 * RULES.md resolution logic. Injected root/registry/fs (no real
 * `~/.agentproto`, no real filesystem) so membership-validated slug→path
 * resolution and the always-inline injection are tested deterministically.
 */

import { describe, it, expect } from "vitest"
import { join, resolve } from "node:path"
import {
  resolveWorkspaceRules,
  RULES_MD_FILE,
  RULES_MD_MAX_KB,
  type WorkspaceRulesFs,
} from "../workspace-rules.js"
import { DEFAULT_BUCKET } from "../workspace-buckets.js"

function bytes(n: number): Buffer {
  return Buffer.alloc(n, 0x62) // 'b' repeated
}

/** A fake fs rooted at no real disk. `files` maps absolute paths -> bytes. */
function fakeFs(files: Record<string, Buffer>): WorkspaceRulesFs {
  return {
    exists: async p => Object.prototype.hasOwnProperty.call(files, resolve(p)),
    read: async p => {
      const entry = files[resolve(p)]
      if (entry === undefined) throw new Error(`ENOENT: ${p}`)
      return entry
    },
  }
}

function deps(opts: {
  root: string
  registered?: string[]
  files?: Record<string, Buffer>
}): {
  root: string
  registered: ReadonlySet<string>
  fs: WorkspaceRulesFs
} {
  return {
    root: opts.root,
    registered: new Set(opts.registered ?? []),
    fs: fakeFs(opts.files ?? {}),
  }
}

describe("resolveWorkspaceRules — membership-validated slug→path (security)", () => {
  const root = resolve("/buckets")

  it("an unregistered slug lands in the `default` bucket — its RULES.md path stays under the root (never escapes)", async () => {
    // A malicious slug trying to climb out of the bucket root with `../`. A
    // RULES.md exists in the `default` bucket but nowhere up-tree; if the
    // resolver naively joined the slug into a path, it would try to read
    // `/etc/...` and find nothing. Correct behaviour: membership validation
    // maps it to `default`, so the DEFAULT bucket's file is the one read.
    const d = deps({
      root,
      registered: ["agentik-studio"],
      files: { [join(root, "default", RULES_MD_FILE)]: bytes(7) },
    })
    const res = await resolveWorkspaceRules("../../etc/passwd", d)
    expect(res.path).toBe(join(resolve(root), DEFAULT_BUCKET, RULES_MD_FILE))
    expect(res.content).toBe(bytes(7).toString("utf8"))
    // Explicitly assert the resolved path never escaped the bucket root.
    expect(res.path!.startsWith(resolve(root) + "/")).toBe(true)
  })

  it("a registered slug reads its OWN bucket's RULES.md, not the default's", async () => {
    const d = deps({
      root,
      registered: ["agentik-studio"],
      files: {
        [join(root, "agentik-studio", RULES_MD_FILE)]: bytes(5),
        [join(root, "default", RULES_MD_FILE)]: bytes(9),
      },
    })
    const res = await resolveWorkspaceRules("agentik-studio", d)
    expect(res.path).toBe(join(resolve(root), "agentik-studio", RULES_MD_FILE))
    expect(res.content).toBe(bytes(5).toString("utf8"))
  })

  it("undefined slug resolves to the default bucket", async () => {
    const d = deps({
      root,
      registered: ["agentik-studio"],
      files: { [join(root, "default", RULES_MD_FILE)]: bytes(3) },
    })
    const res = await resolveWorkspaceRules(undefined, d)
    expect(res.path).toBe(join(resolve(root), DEFAULT_BUCKET, RULES_MD_FILE))
    expect(res.content).toBe(bytes(3).toString("utf8"))
  })
})

describe("resolveWorkspaceRules — always-inline injection (present/absent/cap)", () => {
  const root = resolve("/buckets")

  it("present → full content inlined, clearly delimited, path + block carried", async () => {
    const d = deps({
      root,
      registered: ["x"],
      files: { [join(root, "x", RULES_MD_FILE)]: bytes(120) },
    })
    const res = await resolveWorkspaceRules("x", d)
    expect(res.path).toBe(join(resolve(root), "x", RULES_MD_FILE))
    expect(res.content).toBe(bytes(120).toString("utf8"))
    expect(res.block).toContain(`--- Workspace RULES.md (${join(resolve(root), "x", RULES_MD_FILE)}) ---`)
    expect(res.block).toContain("--- end Workspace RULES.md ---")
    expect(res.block).toContain(res.content!)
  })

  it("absent → nothing injected, no path, no content (workspace opts in by presence)", async () => {
    const d = deps({ root, registered: ["x"], files: {} })
    const res = await resolveWorkspaceRules("x", d)
    expect(res.path).toBeUndefined()
    expect(res.content).toBeUndefined()
    expect(res.block).toBeUndefined()
  })

  it("a file over the hard cap is inlined truncated to the cap (with warning), still present", async () => {
    const over = RULES_MD_MAX_KB * 1024 + 100
    const d = deps({
      root,
      registered: ["x"],
      files: { [join(root, "x", RULES_MD_FILE)]: bytes(over) },
    })
    const res = await resolveWorkspaceRules("x", d)
    expect(res.path).toBe(join(resolve(root), "x", RULES_MD_FILE))
    expect(res.content).toBe(bytes(RULES_MD_MAX_KB * 1024).toString("utf8"))
    expect(res.block).toContain("--- Workspace RULES.md")
  })
})
