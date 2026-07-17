/**
 * Unit tests for lens resolution: the built-in catalog, workspace-declared
 * `lenses/<id>.md` overrides, the `--lens-file` escape hatch, and the tolerant
 * declaration parser.
 */

import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { BUILTIN_LENSES, CRAFT_LENS, builtinLensIds } from "../builtin.js"
import { LensError, parseLensDoc, resolveLens, resolveLensFile } from "../resolve.js"

let tmp: string

beforeEach(async () => {
  tmp = path.join(tmpdir(), `corpus-lens-test-${Math.random().toString(36).slice(2)}`)
  await mkdir(tmp, { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeLens(id: string, content: string): Promise<string> {
  const dir = path.join(tmp, "lenses")
  await mkdir(dir, { recursive: true })
  const p = path.join(dir, `${id}.md`)
  await writeFile(p, content, "utf8")
  return p
}

describe("built-in catalog", () => {
  it("ships a craft lens keyed by id", () => {
    expect(builtinLensIds()).toContain("craft")
    expect(BUILTIN_LENSES.craft).toBe(CRAFT_LENS)
  })

  it("the craft lens extracts writing-craft moves (aspect, kinds, mode)", () => {
    expect(CRAFT_LENS.aspect).toBe("craft")
    expect(CRAFT_LENS.mode).toBe("log")
    expect(CRAFT_LENS.kinds).toEqual(["pattern", "principle", "critique", "example"])
    // craft = HOW it is written, not the topic
    expect(CRAFT_LENS.prompt).toMatch(/WRITING-CRAFT MOVES/)
    expect(CRAFT_LENS.prompt).toMatch(/IGNORE what it is about/)
    // a summary is topic content, not a craft move
    expect(CRAFT_LENS.kinds).not.toContain("summary")
  })
})

describe("resolveLens", () => {
  it("resolves a built-in by id when the workspace declares none", async () => {
    const lens = await resolveLens("craft", tmp)
    expect(lens).toBe(CRAFT_LENS)
  })

  it("a workspace lenses/<id>.md overrides the built-in of the same id", async () => {
    await writeLens(
      "craft",
      ["---", "label: My craft", "aspect: house-craft", "mode: log", "---", "", "House craft rules only."].join("\n")
    )
    const lens = await resolveLens("craft", tmp)
    expect(lens.label).toBe("My craft")
    expect(lens.aspect).toBe("house-craft")
    expect(lens.prompt).toBe("House craft rules only.")
    expect(lens).not.toBe(CRAFT_LENS)
  })

  it("resolves a purely workspace-declared lens", async () => {
    await writeLens(
      "depth",
      ["---", "label: Depth", "kinds: [pattern, principle]", "---", "", "Extract how the piece manufactures depth."].join("\n")
    )
    const lens = await resolveLens("depth", tmp)
    expect(lens.id).toBe("depth")
    expect(lens.kinds).toEqual(["pattern", "principle"])
    expect(lens.prompt).toBe("Extract how the piece manufactures depth.")
    expect(lens.mode).toBe("log")
  })

  it("throws LensError listing built-ins for an unknown lens", async () => {
    await expect(resolveLens("nope", tmp)).rejects.toBeInstanceOf(LensError)
    await expect(resolveLens("nope", tmp)).rejects.toThrow(/craft/)
  })
})

describe("resolveLensFile", () => {
  it("parses an ad-hoc lens declaration by path", async () => {
    const p = path.join(tmp, "adhoc-lens.md")
    await writeFile(
      p,
      ["---", "id: adhoc", "aspect: gtm", "---", "", "Extract go-to-market moves."].join("\n"),
      "utf8"
    )
    const lens = await resolveLensFile(p)
    expect(lens.id).toBe("adhoc")
    expect(lens.aspect).toBe("gtm")
    expect(lens.prompt).toBe("Extract go-to-market moves.")
  })

  it("falls back to the filename for the id when frontmatter omits it", async () => {
    const p = path.join(tmp, "voice.md")
    await writeFile(p, "Extract voice and register moves.", "utf8")
    const lens = await resolveLensFile(p)
    expect(lens.id).toBe("voice")
    expect(lens.prompt).toBe("Extract voice and register moves.")
  })

  it("throws LensError for a missing file", async () => {
    await expect(resolveLensFile(path.join(tmp, "gone.md"))).rejects.toBeInstanceOf(LensError)
  })
})

describe("parseLensDoc", () => {
  it("prefers the body as the prompt, frontmatter prompt as fallback", () => {
    const withBody = parseLensDoc(
      ["---", "prompt: from frontmatter", "---", "", "from body"].join("\n"),
      "x"
    )
    expect(withBody.prompt).toBe("from body")

    const noBody = parseLensDoc(["---", "prompt: only frontmatter", "---", ""].join("\n"), "x")
    expect(noBody.prompt).toBe("only frontmatter")
  })

  it("defaults mode to log and drops invalid kinds", () => {
    const lens = parseLensDoc(
      ["---", "mode: nonsense", "kinds: [pattern, bogus, principle]", "---", "", "p"].join("\n"),
      "x"
    )
    expect(lens.mode).toBe("log")
    expect(lens.kinds).toEqual(["pattern", "principle"])
  })

  it("honours mode: synthesis and synthesisPath", () => {
    const lens = parseLensDoc(
      ["---", "mode: synthesis", "synthesisPath: synthesis/x.md", "---", "", "p"].join("\n"),
      "x"
    )
    expect(lens.mode).toBe("synthesis")
    expect(lens.synthesisPath).toBe("synthesis/x.md")
  })

  it("throws LensError when there is no prompt at all", () => {
    expect(() => parseLensDoc(["---", "label: empty", "---", "", "   "].join("\n"), "x")).toThrow(
      LensError
    )
  })
})
