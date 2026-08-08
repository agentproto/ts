import { defineWorkflow } from "@agentproto/workflow"

/** Single-agent workflow: triage the inbox. */
export const triageInbox = defineWorkflow({
  id: "triage-inbox",
  name: "Triage Inbox",
  description: "Scan inbox, categorize unread messages, create and apply triage plan.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "triage",
      kind: "agent",
      agent: { ref: "@agentproto/triager" },
      prompt:
        "Scan the inbox for unread messages. Categorize them (urgent, needs-reply, " +
        "newsletter, notification, spam). Create a triage plan: label each category, " +
        "archive newsletters+notifications, keep urgent+needs-reply in inbox. " +
        "Show me the plan before applying.",
    },
  ],
})
