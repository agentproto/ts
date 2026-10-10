// Step 1 of the steward: classify. Rules + the Jev typed classifier only (no
// agent LLM, no free-text reasons) → a persisted snapshot with one recommended
// action per session. With `apply: true` it continues into the act half, which
// is the one-shot `agentproto steward --apply`.
import { ACT_INPUTS, CLASSIFY_RESULT, SHARED_INPUTS, classifySteps } from "../session-steward/two-step.mjs"

export default {
  name: "Session Steward — classify",
  id: "session-steward-classify",
  description:
    "Classify the live and recently ended sessions at one instant: rules plus Jev's typed verdict and " +
    "probabilities, then ONE recommended action each (keep | mark-complete | mark-failed | relaunch | " +
    "needs-input | close-abandoned | archive). Persists a snapshot for `session-steward-act`. " +
    "Never mutates unless `apply` is true (classify + act in one go).",
  version: "0.1.0",
  inputs: {
    ...SHARED_INPUTS,
    ...ACT_INPUTS,
    maxJudged: { type: "number", description: "Most judge-class sessions Jev classifies per run, most RAM first. Default 40.", default: 40 },
    jevModel: { type: "string", description: "Jev model. Default jev-latest.", default: "jev-latest" },
    maxArchive: { type: "number", description: "Most archivable ended sessions listed in the snapshot. Default 100.", default: 100 },
    archiveAfterHours: { type: "number", description: "An ended session with a recorded outcome is recommended `archive` once this old. Default 24.", default: 24 },
  },
  outputs: {},
  steps: classifySteps(),
  result: CLASSIFY_RESULT,
}
