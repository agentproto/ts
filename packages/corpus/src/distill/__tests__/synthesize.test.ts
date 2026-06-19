import { describe, it, expect, vi } from "vitest"
import matter from "gray-matter"
import { MemFs } from "../../knowledge/mem-fs.js"
import {
  synthesizeLens,
  currentLensAtoms,
  lensSynthesisStale,
  buildSynthesisPrompt,
  SYNTHESIS_ROLE_TAG,
  type SynthesisPort,
} from "../synthesize.js"
import type { Lens } from "../lens.js"

const clock = {
  now: () => new Date("2026-06-19T00:00:00Z"),
  nowMs: () => new Date("2026-06-19T00:00:00Z").getTime(),
}

const MARKETING: Lens = {
  id: "marketing",
  label: "Marketing knowledge",
  prompt: "Extract positioning and GTM decisions.",
  mode: "synthesis",
}

/** Build an entry markdown file with the frontmatter synthesis reads. */
function entry(fm: {
  slug: string
  title: string
  tags: string[]
  confidence?: number
  supersedes?: string[]
  status?: string
}): string {
  return matter.stringify(`\nBody of ${fm.slug}.`, {
    schema: "knowledge.entry/v1",
    slug: fm.slug,
    kind: "principle",
    title: fm.title,
    confidence: fm.confidence ?? 0.7,
    tags: fm.tags,
    ...(fm.supersedes ? { supersedes: fm.supersedes } : {}),
    ...(fm.status ? { metadata: { corpus: { status: fm.status } } } : {}),
  })
}

function fakeSynthesizer(): SynthesisPort {
  return { synthesize: vi.fn(async i => `# ${i.label}\n\n${i.atoms.length} atoms consolidated.`) }
}

describe("currentLensAtoms — the current (non-superseded) view", () => {
  it("includes aspect atoms, excludes superseded / archived / synthesis", async () => {
    const fs = new MemFs({
      "entries/principles/old.md": entry({ slug: "old", title: "Freemium tier", tags: ["aspect:marketing"], confidence: 0.6 }),
      "entries/principles/new.md": entry({ slug: "new", title: "No freemium", tags: ["aspect:marketing"], confidence: 0.9, supersedes: ["old"] }),
      "entries/principles/other.md": entry({ slug: "other", title: "Unrelated", tags: ["aspect:sales"] }),
      "entries/principles/dead.md": entry({ slug: "dead", title: "Archived one", tags: ["aspect:marketing"], status: "archived" }),
      "entries/summaries/marketing-knowledge.md": entry({ slug: "marketing-knowledge", title: "prior synth", tags: ["aspect:marketing", SYNTHESIS_ROLE_TAG] }),
    })

    const atoms = await currentLensAtoms(fs, MARKETING)
    const slugs = atoms.map(a => a.slug)
    expect(slugs).toEqual(["new"]) // old superseded, sales wrong aspect, dead archived, synth excluded
  })
})

describe("synthesizeLens", () => {
  it("rebuilds the artifact as a role:synthesis entry from current atoms", async () => {
    const fs = new MemFs({
      "entries/principles/a.md": entry({ slug: "a", title: "Lead with safety", tags: ["aspect:marketing"], confidence: 0.9 }),
      "entries/principles/b.md": entry({ slug: "b", title: "Sell to founders", tags: ["aspect:marketing"], confidence: 0.8 }),
    })
    const synthesizer = fakeSynthesizer()

    const report = await synthesizeLens({ fs, clock, synthesizer, lens: MARKETING })

    expect(report.wrote).toBe(true)
    expect(report.atomsUsed).toBe(2)
    expect(report.path).toBe("entries/summaries/marketing-knowledge.md")

    const written = matter(await fs.readFile(report.path!))
    expect(written.data.tags).toEqual(["aspect:marketing", "role:synthesis"])
    expect(written.data.kind).toBe("summary")
    expect(written.data.sources).toEqual(["a", "b"]) // provenance = its atoms

    // re-running excludes its own output — atom count stays 2, not 3
    const second = await synthesizeLens({ fs, clock, synthesizer, lens: MARKETING })
    expect(second.atomsUsed).toBe(2)
  })

  it("is a no-op when the aspect has no current atoms", async () => {
    const fs = new MemFs({})
    const report = await synthesizeLens({ fs, clock, synthesizer: fakeSynthesizer(), lens: MARKETING })
    expect(report.wrote).toBe(false)
    expect(report.atomsUsed).toBe(0)
  })
})

describe("lensSynthesisStale", () => {
  const atom = (slug: string, conf = 0.8) =>
    entry({ slug, title: slug, tags: ["aspect:marketing"], confidence: conf })

  it("missing artifact with atoms ⇒ stale (missing)", async () => {
    const fs = new MemFs({ "entries/principles/a.md": atom("a") })
    const s = await lensSynthesisStale(fs, MARKETING)
    expect(s).toMatchObject({ stale: true, reason: "missing", atomCount: 1 })
  })

  it("fresh right after a rebuild, drifts when a new atom lands", async () => {
    const fs = new MemFs({ "entries/principles/a.md": atom("a") })
    await synthesizeLens({ fs, clock, synthesizer: fakeSynthesizer(), lens: MARKETING })
    expect((await lensSynthesisStale(fs, MARKETING)).reason).toBe("fresh")

    // a new decision lands → atom set drifts from what the artifact recorded
    await fs.writeFile("entries/principles/b.md", atom("b"))
    const s = await lensSynthesisStale(fs, MARKETING)
    expect(s).toMatchObject({ stale: true, reason: "drifted", atomCount: 2 })
  })

  it("no atoms and no artifact ⇒ fresh (nothing to do)", async () => {
    const s = await lensSynthesisStale(new MemFs({}), MARKETING)
    expect(s).toMatchObject({ stale: false, reason: "fresh", atomCount: 0 })
  })
})

describe("buildSynthesisPrompt", () => {
  it("includes the aspect, label, and every atom", () => {
    const p = buildSynthesisPrompt({
      aspect: "marketing",
      label: "Marketing knowledge",
      atoms: [{ slug: "a", title: "Lead with safety", body: "Safety first." }],
    })
    expect(p).toContain("marketing")
    expect(p).toContain("Marketing knowledge")
    expect(p).toContain("Lead with safety")
    expect(p).toContain("Safety first.")
  })
})
