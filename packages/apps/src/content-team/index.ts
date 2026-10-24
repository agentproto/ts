/**
 * `content-team` — a ready-made agentproto app: a small team that produces a
 * piece of content. Three agents (researcher → writer → editor) bound to one
 * production workflow, declared with `@agentproto/app-kit`.
 *
 * Generic on purpose — `@agentproto/…` ids, no product dependency. A host
 * imports it and uses any subset of its agents/workflows.
 */

import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { researcher } from "./agents/researcher.js"
import { writer } from "./agents/writer.js"
import { editor } from "./agents/editor.js"
import { illustrator } from "./agents/illustrator.js"
import { produceContent } from "./workflows/produce-content.js"
import { produceCover } from "./workflows/produce-cover.js"

export const contentTeam: AppHandle = defineApp({
  id: "@agentproto/content-team",
  name: "Content Team",
  version: "0.1.0",
  description: "Research, draft, edit, and illustrate content.",
  agents: [researcher, writer, editor, illustrator],
  workflows: [produceContent, produceCover],
})

export { researcher, writer, editor, illustrator, produceContent, produceCover }
