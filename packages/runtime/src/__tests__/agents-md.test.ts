/**
 * Unit coverage for `agents-md.ts` (WP-R2) — the pure AGENTS.md resolution +
 * injection logic. Injected fs (no real git, no real filesystem) so the walk
 * and the inline/pointer threshold boundary are tested deterministically.
 */

import { describe, it, expect } from "vitest"
import { join, resolve } from "node:path"
import {
  findAgentsMdPath,
  resolveAgentsMd,
  loadAgentsMdInlineMaxKb,
  DEFAULT_AGENTS_MD_INLINE_MAX_KB,
  type AgentsMdFs,
} from "../agents-md.js"

function bytes(n: number): Buffer {
  return Buffer.alloc(n, 0x61) // 'a' repeated
}

/** A fake fs rooted at no real disk. `files` maps absolute paths -> bytes;
 *  `toplevel` is the git-toplevel resolver result (undefined ⇒ non-repo). */
function fakeFs(opts: {
  files?: Record<string, Buffer>
  toplevel?: string | undefined
}): AgentsMdFs {
  const files = opts.files ?? {}
  return {
    exists: async p => Object.prototype.hasOwnProperty.call(files, resolve(p)),
    read: async p => {
      const entry = files[resolve(p)]
      if (entry === undefined) throw new Error(`ENOENT: ${p}`)
      return entry
    },
    gitToplevel: async () => (opts.toplevel === undefined ? undefined : resolve(opts.toplevel)),
  }
}

describe("findAgentsMdPath — the resolution walk", () => {
  const root = resolve("/repo")

  it("non-git cwd with an AGENTS.md at cwd → resolves it (no walk up)", async () => {
    const fs = fakeFs({
      toplevel: undefined,
      files: { [join(root, "sub", "AGENTS.md")]: bytes(1) },
    })
    expect(await findAgentsMdPath(join(root, "sub"), fs)).toBe(join(root, "sub", "AGENTS.md"))
  })

  it("non-git cwd with no AGENTS.md → absent; does NOT walk up to a parent", async () => {
    const fs = fakeFs({
      toplevel: undefined,
      // A parent would HAVE an AGENTS.md, but a non-repo cwd must not see it.
      files: {
        [join(root, "AGENTS.md")]: bytes(1),
      },
    })
    expect(await findAgentsMdPath(join(root, "sub", "deep"), fs)).toBeUndefined()
  })

  it("nearest wins: a cwd-level AGENTS.md beats an ancestor's", async () => {
    const fs = fakeFs({
      toplevel: root,
      files: {
        [join(root, "AGENTS.md")]: bytes(1),
        [join(root, "sub", "AGENTS.md")]: bytes(2),
      },
    })
    expect(await findAgentsMdPath(join(root, "sub", "deep"), fs)).toBe(join(root, "sub", "AGENTS.md"))
  })

  it("cwd's own AGENTS.md wins over everything", async () => {
    const fs = fakeFs({
      toplevel: root,
      files: {
        [join(root, "AGENTS.md")]: bytes(1),
        [join(root, "sub", "deep", "AGENTS.md")]: bytes(3),
      },
    })
    expect(await findAgentsMdPath(join(root, "sub", "deep"), fs)).toBe(
      join(root, "sub", "deep", "AGENTS.md"),
    )
  })

  it("uses the toplevel's own AGENTS.md when no closer one exists", async () => {
    const fs = fakeFs({
      toplevel: root,
      files: { [join(root, "AGENTS.md")]: bytes(1) },
    })
    expect(await findAgentsMdPath(join(root, "sub", "deep"), fs)).toBe(join(root, "AGENTS.md"))
  })

  it("stops at the git toplevel — never walks up into an outer/parent repo", async () => {
    // Nested repo: its toplevel is /repo/sub, so /repo/AGENTS.md (belonging to
    // the OUTER repo) is out of scope and must NOT be picked up.
    const fs = fakeFs({
      toplevel: join(root, "sub"),
      files: {
        [join(root, "AGENTS.md")]: bytes(1), // outer repo — must be invisible.
        [join(root, "sub", "AGENTS.md")]: bytes(2), // nested repo root candidate.
      },
    })
    expect(await findAgentsMdPath(join(root, "sub", "nested"), fs)).toBe(
      join(root, "sub", "AGENTS.md"),
    )

    // And when the nested repo has NO AGENTS.md, the walk reports absent rather
    // than leaking up to the outer repo's.
    const fs2 = fakeFs({
      toplevel: join(root, "sub"),
      files: { [join(root, "AGENTS.md")]: bytes(1) },
    })
    expect(await findAgentsMdPath(join(root, "sub", "nested"), fs2)).toBeUndefined()
  })
})

describe("resolveAgentsMd — inline/pointer/absent threshold boundary", () => {
  const cwd = resolve("/cwd")
  const kb = DEFAULT_AGENTS_MD_INLINE_MAX_KB // 8

  const singleAtCwd = (size: number): AgentsMdFs =>
    fakeFs({
      toplevel: cwd,
      files: { [join(cwd, "AGENTS.md")]: bytes(size) },
    })

  it("matches the file against the default threshold (8 KiB) when none passed", async () => {
    // 8 KiB exactly ⇒ `>=` the threshold ⇒ pointer, NOT inline.
    const exactly = await resolveAgentsMd(cwd, kb, singleAtCwd(8192))
    expect(exactly.mode).toBe("pointer")
    expect(exactly.path).toBe(join(cwd, "AGENTS.md"))
    expect(exactly.block).toContain("read it before your first tool call")
  })

  it("one byte under the threshold ⇒ inlined in full, clearly delimited", async () => {
    const res = await resolveAgentsMd(cwd, kb, singleAtCwd(8191))
    expect(res.mode).toBe("inline")
    expect(res.content).toBe(bytes(8191).toString("utf8"))
    expect(res.block).toContain(`--- AGENTS.md (${join(cwd, "AGENTS.md")}) ---`)
    expect(res.block).toContain("--- end AGENTS.md ---")
    expect(res.block).toContain(res.content!)
  })

  it("exactly at the threshold ⇒ pointer (strictly-less-than gate)", async () => {
    const exactly = await resolveAgentsMd(cwd, kb, singleAtCwd(8192))
    expect(exactly.mode).toBe("pointer")
    expect(exactly.path).toBe(join(cwd, "AGENTS.md"))
  })

  it("one byte over the threshold ⇒ pointer", async () => {
    const over = await resolveAgentsMd(cwd, kb, singleAtCwd(8193))
    expect(over.mode).toBe("pointer")
    expect(over.block).toContain("read it before your first tool call")
    expect(over.content).toBeUndefined()
  })

  it("respects an overridden inlineMaxKb (config field)", async () => {
    // threshold of 2 KiB, at exactly 2 KiB ⇒ pointer.
    const exactly = await resolveAgentsMd(cwd, 2, singleAtCwd(2048))
    expect(exactly.mode).toBe("pointer")
    // 2 KiB - 1 ⇒ inline.
    const under = await resolveAgentsMd(cwd, 2, singleAtCwd(2047))
    expect(under.mode).toBe("inline")
    // 2 KiB + 1 ⇒ pointer.
    const over = await resolveAgentsMd(cwd, 2, singleAtCwd(2049))
    expect(over.mode).toBe("pointer")
  })

  it("absent: nothing found up the walk → mode 'absent', no path, no block", async () => {
    const res = await resolveAgentsMd(
      join(cwd, "sub"),
      kb,
      fakeFs({ toplevel: cwd, files: {} }),
    )
    expect(res.mode).toBe("absent")
    expect(res.path).toBeUndefined()
    expect(res.block).toBeUndefined()
  })

  it("always carries the standing cd-contract line, every mode", async () => {
    const inline = await resolveAgentsMd(cwd, kb, singleAtCwd(4))
    expect(inline.contractLine).toContain("cd")
    const pointer = await resolveAgentsMd(cwd, kb, singleAtCwd(8192))
    expect(pointer.contractLine).toContain("cd")
    const absent = await resolveAgentsMd(
      join(cwd, "sub"),
      kb,
      fakeFs({ toplevel: cwd, files: {} }),
    )
    expect(absent.contractLine).toContain("cd")
  })
})

describe("loadAgentsMdInlineMaxKb — config field > default", () => {
  it("defaults to 8 when the config carries no agentsMd block", async () => {
    expect(await loadAgentsMdInlineMaxKb(async () => ({}))).toBe(8)
    expect(await loadAgentsMdInlineMaxKb(async () => ({ agentsMd: {} }))).toBe(8)
  })

  it("uses the config value when set", async () => {
    expect(
      await loadAgentsMdInlineMaxKb(async () => ({ agentsMd: { inlineMaxKb: 16 } })),
    ).toBe(16)
  })
})