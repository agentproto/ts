// Step 3 of the steward: act. Applies a persisted snapshot by the default
// policy or custom rules — a dry run unless `apply`.
import { ACT_INPUTS, ACT_RESULT, SHARED_INPUTS, SNAPSHOT_INPUTS, actWorkflowSteps } from "../session-steward/two-step.mjs"

export default {
  name: "Session Steward — act",
  id: "session-steward-act",
  description:
    "Act on a classify/analyze snapshot: re-check each session against the live registry (a session that " +
    "changed since the snapshot is skipped, not touched), apply the rules (custom file first, then the " +
    "defaults), bound by origin (a user-origin session is never closed), and run the resulting daemon verbs " +
    "with the outcome fields recorded. Dry run unless `apply` is true.",
  version: "0.1.0",
  inputs: {
    ...SHARED_INPUTS,
    ...SNAPSHOT_INPUTS,
    ...ACT_INPUTS,
  },
  outputs: {},
  steps: actWorkflowSteps(),
  result: ACT_RESULT,
}
