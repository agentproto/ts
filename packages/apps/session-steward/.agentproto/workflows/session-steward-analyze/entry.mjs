// Step 2 of the steward: analyze. An LLM pass over ONLY the relevant sessions
// of a persisted snapshot; writes reason / question / errorKind / nextStep /
// relaunchHint into it. Never acts.
import { ANALYZE_RESULT, SHARED_INPUTS, SNAPSHOT_INPUTS, analyzeSteps } from "../session-steward/two-step.mjs"

export default {
  name: "Session Steward — analyze",
  id: "session-steward-analyze",
  description:
    "Read the relevant sessions of a classify snapshot (action not `keep`, low confidence, or selected) and " +
    "record why: the failure/completion reason, the open question, the error kind, the next step and a " +
    "relaunch hint. May revise the recommended action (the classify verdict is kept alongside). Writes the " +
    "result back into the same snapshot. Never closes, kills or archives anything.",
  version: "0.1.0",
  inputs: {
    ...SHARED_INPUTS,
    ...SNAPSHOT_INPUTS,
    only: { type: "array", description: "Analyse only rows whose recommended action is one of these.", items: { type: "string" } },
    sessions: { type: "array", description: "Analyse exactly these session ids (even a `keep` row).", items: { type: "string" } },
    judge: { type: "string", description: "`agent` (default: one-shot analyst agent) or `jev` (no LLM spend: structured heuristic reasons from the evidence).", default: "agent" },
    maxSessions: { type: "number", description: "Most sessions analysed per run. Default 20.", default: 20 },
    judgeModel: { type: "string", description: "Model for the analyst agent. Default: the `judge.session` model role." },
  },
  outputs: {},
  steps: analyzeSteps(),
  result: ANALYZE_RESULT,
}
