import type { Classifier, ClassifierRegistry, ClassifyContext, Envelope, Level } from "./types.js"

/** Exact match, or a prefix match for a `*`-suffixed pattern. A bare `*`
 *  matches everything. */
function matchesType(pattern: string, type: string): boolean {
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}

function covers(c: Classifier, type: string): boolean {
  return c.types.some((p) => matchesType(p, type))
}

interface Entry {
  readonly c: Classifier
  readonly token: object
}

export function createClassifierRegistry(): ClassifierRegistry {
  const entries: Entry[] = []

  return {
    register(c: Classifier): () => void {
      const token = {}
      const idx = entries.findIndex((x) => x.c.id === c.id)
      if (idx === -1) entries.push({ c, token })
      else entries[idx] = { c, token }
      let active = true
      return () => {
        if (!active) return
        active = false
        const at = entries.findIndex((x) => x.token === token)
        if (at !== -1) entries.splice(at, 1)
      }
    },

    classify(env: Envelope, ctx: ClassifyContext): { level: Level; rule: string } {
      for (const { c } of entries) {
        if (!covers(c, env.type)) continue
        const level = c.classify(env, ctx)
        if (level !== undefined) return { level, rule: c.id }
      }
      return { level: env.levelHint ?? 2, rule: "default" }
    },

    list(): readonly Classifier[] {
      return entries.map((x) => x.c)
    },
  }
}
