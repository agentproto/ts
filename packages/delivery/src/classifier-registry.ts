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

export function createClassifierRegistry(): ClassifierRegistry {
  const classifiers: Classifier[] = []

  return {
    register(c: Classifier): () => void {
      const idx = classifiers.findIndex((x) => x.id === c.id)
      if (idx === -1) classifiers.push(c)
      else classifiers[idx] = c
      return () => {
        const at = classifiers.indexOf(c)
        if (at !== -1) classifiers.splice(at, 1)
      }
    },

    match(env: Envelope): Classifier | undefined {
      return classifiers.find((c) => covers(c, env.type))
    },

    classify(env: Envelope, ctx: ClassifyContext): { level: Level; rule: string } {
      for (const c of classifiers) {
        if (!covers(c, env.type)) continue
        const level = c.classify(env, ctx)
        if (level !== undefined) return { level, rule: c.id }
      }
      return { level: env.levelHint ?? 2, rule: "default" }
    },

    list(): readonly Classifier[] {
      return [...classifiers]
    },
  }
}
