import { describe, it, expect } from "vitest"
import {
  parseSlashInvocation,
  matchSlashCommand,
  classifySlashPrompt,
  asSlashPromptBlocks,
} from "../slash-dispatch.js"
import type { SlashCommandEntry } from "../slash-dispatch.js"

/**
 * `slash-dispatch.ts` — decision layer for generic slash-command dispatch
 * over ACP (`available_commands_update` + first-text-block anchored
 * prompt transport). The behavioral contract the hermes`
 * `_handle_slash_command` / opencode `detectSlashCommand` recon pinned:
 * dispatch happens ADAPTER-side on the VERBATIM leading slash of the first
 * text block, so a host must not prefix and must not eat unknown slashes.
 */

const hermesCommands: SlashCommandEntry[] = [
  { name: "help", description: "List available commands" },
  { name: "compress", description: "Compress conversation context" },
  { name: "steer", description: "Inject guidance", input: { hint: "guidance for the active turn" } },
  { name: "queue", description: "Queue a prompt", input: { hint: "prompt to run next" } },
]

const claudeMetaCommand: SlashCommandEntry[] = [
  {
    name: "review:security",
    description: "Scoped skill",
    _meta: { bareName: "security", qualifiedName: "review:security" },
  },
]

describe("parseSlashInvocation", () => {
  it("parses /name plus args", () => {
    expect(parseSlashInvocation("/model gpt-x")).toEqual({ name: "/model", args: "gpt-x" })
  })

  it("parses a bare command with empty args", () => {
    expect(parseSlashInvocation("/compact")).toEqual({ name: "/compact", args: "" })
  })

  it("tolerates leading whitespace (not BOM-prefix text)", () => {
    expect(parseSlashInvocation("\n  /steer hold on")).toEqual({ name: "/steer", args: "hold on" })
  })

  it("travels multi-line tail args verbatim", () => {
    expect(parseSlashInvocation("/queue do it\nthen this")).toEqual({
      name: "/queue",
      args: "do it\nthen this",
    })
  })

  it("rejects non-slash text", () => {
    expect(parseSlashInvocation("compact the session")).toBeUndefined()
  })

  it("rejects a slash that is not the first character — dispatch is prefix-anchored upstream too", () => {
    // This is THE case the bug report is about: a prepended digest in front
    // of "/compact" must NOT classify as a command.
    expect(parseSlashInvocation("3 unread /focuser messages\n\n/compact")).toBeUndefined()
  })

  it("rejects a lone slash or '//'", () => {
    expect(parseSlashInvocation("/")).toBeUndefined()
    expect(parseSlashInvocation("//src")).toBeUndefined()
  })
})

describe("matchSlashCommand", () => {
  it("matches exact and case-insensitive", () => {
    expect(matchSlashCommand("compress", hermesCommands)?.name).toBe("compress")
    expect(matchSlashCommand("Compress", hermesCommands)?.name).toBe("compress")
  })

  it("matches claude-code _meta bareName and qualifiedName", () => {
    expect(matchSlashCommand("/security", claudeMetaCommand)?.name).toBe("review:security")
    expect(matchSlashCommand("/review:security", claudeMetaCommand)?.name).toBe("review:security")
  })

  it("returns undefined on an empty or absent list", () => {
    expect(matchSlashCommand("/help", undefined)).toBeUndefined()
    expect(matchSlashCommand("/help", [])).toBeUndefined()
    expect(matchSlashCommand("/nope", hermesCommands)).toBeUndefined()
  })
})

describe("classifySlashPrompt", () => {
  it("plain text → none (sent as-is)", () => {
    expect(classifySlashPrompt("compact this session please", hermesCommands)).toEqual({
      kind: "none",
      text: "compact this session please",
    })
  })

  it("known command → dispatch verbatim, argsMissing flagged when a hint exists", () => {
    const d = classifySlashPrompt("/compress", hermesCommands)
    expect(d).toMatchObject({ kind: "known", command: { name: "compress" }, argsMissing: false })
    expect(classifySlashPrompt("/steer", hermesCommands)).toMatchObject({
      kind: "known",
      argsMissing: true,
      command: { name: "steer" },
    })
    expect(classifySlashPrompt("/steer wait", hermesCommands)).toMatchObject({ argsMissing: false })
  })

  it("unknown slash stays unknown-slash (adapter owns fall-through)", () => {
    expect(classifySlashPrompt("/definitely-not-a-thing", hermesCommands)).toEqual({
      kind: "unknown-slash",
      invocation: { name: "/definitely-not-a-thing", args: "" },
      text: "/definitely-not-a-thing",
    })
  })

  it("a prefixed digest breaks the prefix-anchored contract → none", () => {
    // The prepended-digest regression: a digest in front of a slash.
    const digest = "<agentproto-inbox unread=\"3\">You have 3 unread fyi…\n\n"
    expect(classifySlashPrompt(digest + "/compress", hermesCommands).kind).toBe("none")
  })

  it("never throws on weird input", () => {
    expect(classifySlashPrompt("", hermesCommands).kind).toBe("none")
    expect(classifySlashPrompt("/", [])).toEqual({ kind: "none", text: "/" })
  })
})

describe("asSlashPromptBlocks", () => {
  it("passes text verbatim as the single first block", () => {
    expect(asSlashPromptBlocks("/compact")).toEqual([{ type: "text", text: "/compact" }])
  })
})
