import { describe, it, expect } from "vitest"
import { parseWorkflowManifest } from "../manifest/index.js"

const FRONTMATTER = (extra: string) =>
  [
    "---",
    "name: Routines",
    "id: routines-md",
    "description: A workflow driven by routines.",
    "version: 0.1.0",
    "inputs: {}",
    "outputs: {}",
    "steps:",
    "  - id: s",
    "    kind: tool",
    "    tool: noop",
    extra,
    "---",
    "",
    "## Overview",
    "",
    "Body.",
  ].join("\n")

describe("parseWorkflowManifest — routines (AIP-15 × AIP-41)", () => {
  it("parses a manifest using the preferred routines: frontmatter", () => {
    const m = parseWorkflowManifest(
      FRONTMATTER(
        [
          "routines:",
          "  - ref: \"@agentik/routines-standard/daily-9am-utc\"",
          "  - file: \"./.routines/quarterly-rotation/ROUTINE.md\"",
          "  - inline:",
          "      schedule: { kind: cron, cron: \"0 9 * * MON\", timezone: \"Europe/Paris\" }",
          "      target: { workflow: { ref: \"./\" } }",
          "      identity: \"bot://acme-routines\"",
        ].join("\n"),
      ),
    )
    expect(m.frontmatter.routines).toEqual([
      { ref: "@agentik/routines-standard/daily-9am-utc" },
      { file: "./.routines/quarterly-rotation/ROUTINE.md" },
      {
        inline: {
          schedule: { kind: "cron", cron: "0 9 * * MON", timezone: "Europe/Paris" },
          target: { workflow: { ref: "./" } },
          identity: "bot://acme-routines",
        },
      },
    ])
  })

  it("still parses a legacy triggers: [{ kind: schedule }] manifest", () => {
    const m = parseWorkflowManifest(
      FRONTMATTER(
        [
          "triggers:",
          "  - kind: schedule",
          "    cron: \"0 9 * * MON\"",
          "    timezone: \"Europe/Paris\"",
        ].join("\n"),
      ),
    )
    expect(m.frontmatter.triggers).toEqual([
      { kind: "schedule", cron: "0 9 * * MON", timezone: "Europe/Paris" },
    ])
  })
})
