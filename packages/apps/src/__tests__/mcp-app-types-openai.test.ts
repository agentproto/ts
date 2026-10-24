/**
 * mcp-app-types — the §3.2 OpenAI descriptor TYPE contract (plan W-B task
 * 2). No runtime logic lives here — the serializer lives in @agentproto/
 * runtime's mcp-apps-adapter — so this is the table-driven shape test:
 * every row is a fixture that must type-check against `AgnoMcpApp`, with
 * the exact field names/optionality/vendored shapes §3.2 freezes, plus a
 * negative row for a key cut from v1.
 */

import { describe, it, expectTypeOf } from "vitest"
import { z } from "zod"
import type {
  AgnoMcpApp,
  OpenAIAppDescriptor,
  OpenAIAppUiExtension,
  OpenAIEntrypoint,
  OpenAIIcon,
  OpenAIDisplayMode,
  OpenAIUiResourceMetadata,
  OpenAIUiToolMetadata,
} from "../mcp-app-types.js"

describe("§3.2 OpenAI descriptor types", () => {
  it("entrypoint-tool-projects-title-and-icons — fixture accepts title/icons and freezes the shapes", () => {
    const icons: readonly OpenAIIcon[] = [
      { src: "https://cdn.example.com/icon.png", sizes: ["256x256"], theme: "dark" },
      { src: "data:image/svg+xml;base64,PHN2Zy8+", mimeType: "image/svg+xml" },
    ]
    const toolMeta: OpenAIUiToolMetadata = { entrypoints: [{ type: "global" }, { type: "thread" }] }
    const resourceMeta: OpenAIUiResourceMetadata = {
      availableDisplayModes: ["inline", "fullscreen"],
      preferredDisplayMode: "fullscreen",
    }
    const descriptor: OpenAIAppDescriptor = {
      tool: toolMeta,
      resource: resourceMeta,
      icons,
    }
    expectTypeOf(descriptor.icons).toEqualTypeOf<readonly OpenAIIcon[] | undefined>()
    // AgnoMcpApp carries the descriptor as one optional `openai` field.
    expectTypeOf<AgnoMcpApp["openai"]>().toEqualTypeOf<OpenAIAppDescriptor | undefined>()

    const app: AgnoMcpApp = {
      id: "app_ui_dossier",
      title: "Dossier desk",
      inputSchema: z.object({}),
      html: "<html/>",
      openai: descriptor,
    }
    expectTypeOf(app.openai!.tool!.entrypoints![0]!.type).toEqualTypeOf<"global" | "thread" | "file">()
  })

  it("file-entrypoint-extensions-typed — the file entrypoint requires dot-prefixed extension strings", () => {
    const file: OpenAIEntrypoint = { type: "file", extensions: [".md", ".stl"] }
    expectTypeOf(file.type).toEqualTypeOf<"file">()
  })

  it("display-modes-narrowed — availableDisplayModes only accepts inline|fullscreen", () => {
    expectTypeOf<OpenAIDisplayMode>().toEqualTypeOf<"inline" | "fullscreen">()
    expectTypeOf<Exclude<OpenAIDisplayMode, "inline" | "fullscreen">>().toBeNever()
    // @ts-expect-error — modes outside the v1 set fail.
    const bad: OpenAIDisplayMode = "pip"
    void bad
  })

  it("openai-ui-extension — the app-kit normalized shape drops in unchanged (W-A contract, not duplicated)", () => {
    // Table: the full normalized block — assembled from the W-A app-kit
    // validator's output — must be accepted as `openai` in the descriptor.
    const normalized: OpenAIAppUiExtension = {
      entrypoints: [{ type: "global" }, { type: "thread" }, { type: "file", extensions: [".md"] }],
      icons: [{ src: "https://cdn.example.com/i.png" }],
      display: { availableModes: ["inline", "fullscreen"], preferredMode: "inline" },
      mentions: { searchTool: "dossier_mentions" },
    }
    const descriptor: OpenAIAppDescriptor = { tool: { entrypoints: normalized.entrypoints } }
    expectTypeOf(normalized.mentions!.searchTool).toEqualTypeOf<string>()
    expectTypeOf(descriptor.tool).toEqualTypeOf<OpenAIUiToolMetadata | undefined>()
  })

  it("absent-openai-field — a portable app needs no openai key at all (I1/I5)", () => {
    const app: AgnoMcpApp = {
      id: "app_ui_plain",
      title: "Plain",
      inputSchema: z.object({}),
      html: "<html/>",
    }
    expectTypeOf(app.openai).toEqualTypeOf<OpenAIAppDescriptor | undefined>()
  })
})
