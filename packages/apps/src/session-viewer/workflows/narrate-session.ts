import { defineWorkflow } from "@agentproto/workflow"

export const narrateSession = defineWorkflow({
  id: "narrate-session",
  name: "Narrate Session",
  description: "Read a daemon session's transcript and narrate it in plain English.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "narrate",
      kind: "agent",
      agent: { ref: "@agentproto/session-narrator" },
      prompt:
        "Narrate the session named in the run input (or the most recently started session if " +
        "none was given): what the user asked for, what the assistant did, and what — if " +
        "anything — is still open at the end of the transcript.",
    },
  ],
})
