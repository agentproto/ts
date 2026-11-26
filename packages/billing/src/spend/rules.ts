/**
 * Named, ordered rules. A host's policy (a cap, an overdraft rule, a pack
 * limit) is a PURE function that looks at a read-only snapshot and DECIDES: it
 * refuses, or it lowers the amount. It never writes. The core runs the rules in
 * the order given and EXECUTES the outcome; the first rule that decides wins,
 * and the result and its trace name it.
 *
 * The invariants stay with the core and no rule can lift them: a key charges
 * once, the amount a rule returns can only be lower than the one requested, and
 * a rule that throws or answers badly refuses the spend (money fails closed).
 */
export interface Rule<Ctx, Decision> {
  /** Unique within a list; reported as `decidedBy`. */
  name: string
  /** Pure. Return a decision, or `undefined` to pass to the next rule. */
  decide(ctx: Readonly<Ctx>): Decision | undefined
}

export type RuleTrace = { rule: string; outcome: "pass" | "decided" | "error" }

export interface RuleRun<Decision> {
  decision?: Decision
  decidedBy?: string
  trace: RuleTrace[]
  /** Set when a rule threw: the caller must refuse. */
  error?: { rule: string; message: string }
}

/** Why a list of rules is unusable (empty = fine). */
export function ruleProblems(rules: readonly Rule<never, unknown>[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rules) {
    if (!r.name) out.push("a rule has no name")
    if (seen.has(r.name)) out.push(`duplicate rule name '${r.name}'`)
    seen.add(r.name)
  }
  return out
}

/** Run the rules in order; stop at the first that decides. A throwing rule stops the run with `error`. */
export function runRules<Ctx, Decision>(rules: readonly Rule<Ctx, Decision>[], ctx: Readonly<Ctx>): RuleRun<Decision> {
  const trace: RuleTrace[] = []
  for (const r of rules) {
    let d: Decision | undefined
    try {
      d = r.decide(ctx)
    } catch (e) {
      trace.push({ rule: r.name, outcome: "error" })
      return { trace, error: { rule: r.name, message: e instanceof Error ? e.message : String(e) } }
    }
    if (d === undefined) {
      trace.push({ rule: r.name, outcome: "pass" })
      continue
    }
    trace.push({ rule: r.name, outcome: "decided" })
    return { decision: d, decidedBy: r.name, trace }
  }
  return { trace }
}
