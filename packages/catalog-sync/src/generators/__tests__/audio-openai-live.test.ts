/**
 * audio:openai-live generator tests — OFFLINE only. The /v1/models payload is
 * mocked inline (the committed snapshot is covered too, via the same offline
 * ctx as the voice generator tests); no test touches the network.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { audioOpenAILive, isLiveAudioId } from "../audio-openai-live.js"
import type { GeneratorContext, CatalogSource } from "../../types.js"

/** Minimal /v1/models-shaped payload, mixing the families the filter must
 * separate: live/realtime engines IN, cascade TTS/STT + date-pinned pins OUT. */
const MOCK_MODELS_PAYLOAD = {
  object: "list",
  data: [
    {
      id: "gpt-live-1.1", // curated on main → needsCuration false
      object: "model",
      created: 1764115200,
      owned_by: "system",
      shutdown_date: null as string | null,
    },
    {
      id: "gpt-future-live", // not curated anywhere → needsCuration true
      object: "model",
      created: 1767225600,
      owned_by: "openai",
      shutdown_date: null as string | null,
    },
    {
      id: "gpt-realtime-2.1", // curated → needsCuration false
      object: "model",
      created: 1753990800,
      owned_by: "system",
      shutdown_date: null as string | null,
    },
    {
      id: "gpt-4o-realtime-preview", // legacy realtime family still in the roster
      object: "model",
      created: 1726022400,
      owned_by: "system",
      shutdown_date: "2026-08-01",
    },
    {
      id: "gpt-realtime-2025-08-28", // date-pinned variant → dropped
      object: "model",
      created: 1755859200,
      owned_by: "system",
      shutdown_date: null as string | null,
    },
    // Cascade audio (TTS/STT) — NOT live session engines, must be filtered out.
    {
      id: "gpt-4o-mini-tts",
      object: "model",
      created: 1742480400,
      owned_by: "system",
      shutdown_date: null as string | null,
    },
    {
      id: "whisper-1",
      object: "model",
      created: 1677532384,
      owned_by: "openai-internal",
      shutdown_date: null as string | null,
    },
    // Text LLMs sharing "live-ish" words — filtered out.
    {
      id: "gpt-5.4",
      object: "model",
      created: 1753990800,
      owned_by: "system",
      shutdown_date: null as string | null,
    },
  ],
}

/** Offline ctx feeding a MOCKED /v1/models payload (snapshot-free path). */
function createMockCtx(payload: unknown = MOCK_MODELS_PAYLOAD): GeneratorContext {
  return {
    refresh: false,
    async fetchSource(_src: CatalogSource): Promise<unknown> {
      return payload
    },
  }
}

/** Offline ctx reading the COMMITTED snapshot (framework's snapshot-first
 * reader, mirrors voice-elevenlabs.test.ts — keeps the test deterministic). */
function createSnapshotCtx(): GeneratorContext {
  return {
    refresh: false,
    async fetchSource(src: CatalogSource): Promise<unknown> {
      const p = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../snapshots",
        `${src.id}.json`,
      )
      return JSON.parse(readFileSync(p, "utf-8"))
    },
  }
}

describe("isLiveAudioId filter", () => {
  it("keeps realtime + live ids, incl. the legacy gpt-4o-realtime family", () => {
    expect(isLiveAudioId("gpt-realtime")).toBe(true)
    expect(isLiveAudioId("gpt-realtime-2.1-mini")).toBe(true)
    expect(isLiveAudioId("gpt-4o-realtime-preview")).toBe(true)
    expect(isLiveAudioId("gpt-live-1.1")).toBe(true)
    expect(isLiveAudioId("gpt-live-transcribe")).toBe(true)
  })

  it("drops cascade TTS/STT engines and text LLMs", () => {
    expect(isLiveAudioId("gpt-4o-mini-tts")).toBe(false)
    expect(isLiveAudioId("gpt-transcribe")).toBe(false)
    expect(isLiveAudioId("whisper-1")).toBe(false)
    expect(isLiveAudioId("gpt-5.4")).toBe(false)
    expect(isLiveAudioId("tts-1-hd-1106")).toBe(false)
  })

  it("drops date-pinned snapshot variants of rolling ids", () => {
    expect(isLiveAudioId("gpt-realtime-2025-08-28")).toBe(false)
    expect(isLiveAudioId("gpt-realtime-mini-2025-12-15")).toBe(false)
  })
})

describe("audio:openai-live generator (mock /v1/models)", () => {
  const OUTPUT = "packages/model-catalog/src/audio/openai-live.generated.ts"

  it("returns a GeneratedFiles record targeting the audio catalog", async () => {
    const result = await audioOpenAILive.generate(createMockCtx())
    expect(Object.keys(result)).toEqual([OUTPUT])
  })

  it("keeps live/realtime ids and filters everything else", async () => {
    const source = (await audioOpenAILive.generate(createMockCtx()))[OUTPUT]!
    expect(source).toContain('"gpt-live-1.1"')
    expect(source).toContain('"gpt-future-live"')
    expect(source).toContain('"gpt-realtime-2.1"')
    expect(source).toContain('"gpt-4o-realtime-preview"')
    // Filtered out:
    expect(source).not.toContain("gpt-4o-mini-tts")
    expect(source).not.toContain("whisper-1")
    expect(source).not.toContain("gpt-5.4")
    expect(source).not.toContain("gpt-realtime-2025-08-28")
  })

  it("emits entries with modality audio, kind live and the provider id", async () => {
    const source = (await audioOpenAILive.generate(createMockCtx()))[OUTPUT]!
    expect(source).toContain("export const OPENAI_LIVE_MODELS")
    expect(source).toContain('import type { AudioLiveModelEntry } from "./live.js"')
    // Every entry carries the shape the catalog's live bridge types expect.
    const entries = (source.match(/providerId: "/g) ?? []).length
    expect(entries).toBe(4) // the 4 live ids of the mock payload
    for (const field of ["modality: \"audio\"", "kind: \"live\""]) {
      expect((source.match(new RegExp(field, "g")) ?? []).length).toBe(entries)
    }
    // Structurally valid TS output: no unquoted undefined slipped through.
    expect(source).not.toContain("undefined")
  })

  it("flags needsCuration from the curated overlay (AUDIO_MODEL_CATALOG)", async () => {
    const source = (await audioOpenAILive.generate(createMockCtx()))[OUTPUT]!
    // gpt-live-1.1 + gpt-realtime-2.1 are curated on main → false.
    expect(source).toContain('"gpt-live-1.1": {\n    providerId: "gpt-live-1.1",\n    modality: "audio",\n    kind: "live",\n    needsCuration: false,')
    // gpt-future-live + legacy gpt-4o-realtime-preview are not curated → true.
    expect(source).toContain("gpt-future-live")
    const bool = source.match(/"gpt-future-live": \{[\s\S]*?needsCuration: (true|false),/)
    expect(bool?.[1]).toBe("true")
    const legacy = source.match(/"gpt-4o-realtime-preview": \{[\s\S]*?needsCuration: (true|false),/)
    expect(legacy?.[1]).toBe("true")
  })

  it("carries provider metadata: ownedBy, createdAt, shutdownDate", async () => {
    const source = (await audioOpenAILive.generate(createMockCtx()))[OUTPUT]!
    // created 1764115200 → 2025-11-26 (unix seconds → ISO date, UTC).
    expect(source).toContain("createdAt: \"2025-11-26\"")
    expect(source).toContain('ownedBy: "openai"')
    expect(source).toContain('shutdownDate: "2026-08-01"')
    // A null shutdown_date emits no line (no fabricated values).
    expect(source).not.toContain("shutdownDate: \"\"")
    // shutdown_date: null rows omit the field entirely — count the lines.
    expect((source.match(/shutdownDate:/g) ?? []).length).toBe(1)
  })

  it("is deterministic and sorted by provider id", async () => {
    const first = await audioOpenAILive.generate(createMockCtx())
    const second = await audioOpenAILive.generate(createMockCtx())
    expect(second[OUTPUT]).toBe(first[OUTPUT])
    // Ids appear in ascending provider-id order in the emitted file.
    const ids = [...first[OUTPUT]!.matchAll(/^  "([^"]+)": \{/gm)].map(m => m[1])
    expect(ids).toEqual([...ids].sort())
  })

  it("rejects a payload that does not look like /v1/models", async () => {
    await expect(
      audioOpenAILive.generate(createMockCtx({ object: "list", data: "nope" })),
    ).rejects.toThrow()
    await expect(
      audioOpenAILive.generate(createMockCtx({ error: { message: "401" } })),
    ).rejects.toThrow()
  })
})

describe("audio:openai-live generator (committed snapshot)", () => {
  it("emits the roster of the pinned /v1/models snapshot", async () => {
    const OUTPUT = "packages/model-catalog/src/audio/openai-live.generated.ts"
    const source = (await audioOpenAILive.generate(createSnapshotCtx()))[OUTPUT]!
    // Snapshot (pinned 2026-11-22) carries these families.
    for (const id of [
      "gpt-live-1",
      "gpt-live-1.1",
      "gpt-live-transcribe",
      "gpt-realtime-2.1",
      "gpt-realtime-mini",
      "gpt-realtime-translate",
      "gpt-realtime-whisper",
    ]) {
      expect(source).toContain(`"${id}": {`)
    }
    // Date-pinned variants stay excluded.
    expect(source).not.toContain("gpt-realtime-2025-08-28")
    // gpt-live-1.1 is curated → flag false in the snapshot-based output too.
    expect(source).toContain(
      '"gpt-live-1.1": {\n    providerId: "gpt-live-1.1",\n    modality: "audio",\n    kind: "live",\n    needsCuration: false,',
    )
  })
})
