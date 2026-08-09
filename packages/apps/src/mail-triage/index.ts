/**
 * `mail-triage` — a single-agent agentproto app for email triage.
 *
 * One agent (triager) scans inbox, categorizes unread mail, and applies
 * triage actions (label, archive). Proves the APP primitive works end-to-end
 * with a simple, useful real-world task.
 */

import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { triager } from "./agents/triager.js"
import { triageInbox } from "./workflows/triage-inbox.js"

export const mailTriage: AppHandle = defineApp({
  id: "@agentproto/mail-triage",
  name: "Mail Triage",
  version: "0.1.0",
  description: "Triage your inbox — categorize, label, archive.",
  agents: [triager],
  workflows: [triageInbox],
})

export { triager, triageInbox }
