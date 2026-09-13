import { defineWorkflow } from "@agentproto/workflow"

/**
 * The one workflow the illustrator uses to produce a cover.
 *
 * A single declarative `kind:"agent"` step — `agent.ref` resolving (at
 * compile time, against this app's own install record) to the illustrator's
 * emitted AGENT.md. This replaces an earlier `ToolStep`-based draft
 * (`content.cover-concept`/`content.cover-base-gen`/`content.cover-cleanup`/
 * `content.cover-upload`) naming tools that don't exist anywhere — no driver
 * implements them. The illustrator agent folds all four phases (concept,
 * base generation, cleanup, upload) into one prompt for a single session
 * turn, matching the tools it already has (`read_file`, `write_file`,
 * `run_command`).
 */
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
    {
      id: "illustrate",
      kind: "agent",
      agent: { ref: "@agentproto/illustrator" },
      prompt:
        "Produce the cover for this article in one pass: (1) read the article " +
        "and derive the single visual concept that best represents it, (2) " +
        "write the art direction as a clean, text-free image prompt and " +
        "generate the base image from it, (3) clean up the generated image " +
        "(crop, color, artifacts), then (4) upload the final cover to the " +
        "workspace's output location.",
    },
  ],
})
