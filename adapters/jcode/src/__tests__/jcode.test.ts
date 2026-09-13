/**
 * Manifest wiring for the jcode print arm. The original arm was broken
 * end-to-end in two independent ways this suite pins against regression:
 *
 * 1. No `output_format` — `jcode run` emitted plain text, which the print
 *    arm's per-line JSON.parse silently dropped, so a session NEVER
 *    replied (the observed "spawns but doesn't answer" bug).
 * 2. `prompt_flag: "run"` — `run` is a clap SUBCOMMAND, and every composed
 *    flag (output_format, `--model` from bin_args_template) landed BEFORE
 *    it in the argv, which jcode rejects ("unexpected argument").
 */
import { describe, expect, it } from "vitest"

import { jcode } from "../index.js"

describe("jcode adapter manifest", () => {
  it("puts the `run` subcommand in bin_args so every composed flag lands after it", () => {
    expect(jcode.bin).toBe("jcode")
    expect(jcode.bin_args).toEqual(["run"])
    // The prompt is positional — a prompt_flag would compose AFTER the
    // output/model flags and be treated as the message, not a subcommand.
    expect(jcode.print?.prompt_flag).toBeUndefined()
  })

  it("requests the NDJSON stream and declares its bespoke event schema", () => {
    expect(jcode.print?.output_format).toEqual(["--ndjson"])
    expect(jcode.print?.event_schema).toBe("jcode-ndjson")
  })

  it("keeps no pre_prompt (the claude-only --no-interactive default would be rejected)", () => {
    expect(jcode.print?.pre_prompt).toEqual([])
  })

  it("resumes via `--resume <session_id>` (ids come from the ndjson start/done lines)", () => {
    expect(jcode.print?.resume).toEqual({ flag: "--resume", kind: "value" })
    expect(jcode.capabilities?.resumable).toBe(true)
  })
})
