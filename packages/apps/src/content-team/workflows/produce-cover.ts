import { defineWorkflow } from "@agentproto/workflow"

/** The one workflow the illustrator uses to produce a cover. */
export const produceCover = defineWorkflow({
  id: "produce-cover",
  name: "Produce a cover illustration",
  description:
    "Read the article, derive the cover concept, generate the base image, " +
    "clean it up, and upload the final cover.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    { id: "concept-from-article", kind: "tool", tool: "content.cover-concept" },
    { id: "base-gen", kind: "tool", tool: "content.cover-base-gen" },
    { id: "cleanup", kind: "tool", tool: "content.cover-cleanup" },
    { id: "upload", kind: "tool", tool: "content.cover-upload" },
  ],
})
