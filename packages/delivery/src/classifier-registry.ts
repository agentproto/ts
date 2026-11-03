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

export function createClassifierRegistry(classifiers: readonly Classifier[]): ClassifierRegistry {
  return {
    classify(env: Envelope, ctx: ClassifyContext): { level: Level; rule: string } {
      for (const c of classifiers) {
        if (!covers(c, env.type)) continue
        const level = c.classify(env, ctx)
        if (level !== undefined) return { level, rule: c.id }
      }
      return { level: env.levelHint ?? 2, rule: "default" }
    },
  }
}
