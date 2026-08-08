import { defineAgent } from "@agentproto/agent"
import type { AgentEntry } from "@agentproto/app-kit"

/** Triages your inbox — finds unread mail, categorizes, labels, archives. */
export const triager: AgentEntry = {
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentproto/triager",
    description: "Triages your inbox — finds unread mail, categorizes, labels, archives.",
    model: "claude-sonnet-5",
    boundaries: [
      "Always show the triage plan before applying",
      "Never delete — only archive, label, or mark read",
      "Ask before applying bulk actions on more than 20 messages",
    ],
    tools: [
      "mailbox_list",
      "mailbox_search",
      "mailbox_list_threads",
      "mailbox_get_thread",
      "mailbox_labels_list",
      "mailbox_label_create",
      "mailbox_triage_plan",
      "mailbox_triage_apply",
    ],
    workflows: [{ ref: "triage-inbox" }],
  }),
  body:
    "You scan the inbox for unread messages using mailbox_search. Categorize them " +
    "(urgent, needs-reply, newsletter, notification, spam). Create a triage plan: " +
    "label each category, archive newsletters+notifications, keep urgent+needs-reply " +
    "in inbox. Show the plan before applying. Use mailbox_triage_plan to build the " +
    "plan and mailbox_triage_apply to execute it after user confirmation.",
}
