import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  defineRef,
  listRefKinds,
  registerRefKind,
  type KindDefinition,
} from "../index.js"

describe("registry — base kinds present", () => {
  it("lists all eleven base kinds", () => {
    const kinds = listRefKinds()
    expect(kinds).toEqual(
      expect.arrayContaining([
        "email",
        "eth_tx",
        "git",
        "github",
        "ipfs",
        "local",
        "operator",
        "ots",
        "persona",
        "url",
        "user",
      ])
    )
  })
})

describe("registry — extension via registerRefKind", () => {
  interface YouTubeRef {
    kind: "youtube_video"
    videoId: string
    t?: number
  }

  const youtubeKind: KindDefinition<YouTubeRef> = {
    kind: "youtube_video",
    collections: ["media"],
    schema: z.object({
      kind: z.literal("youtube_video"),
      videoId: z.string().min(1),
      t: z.number().int().nonnegative().optional(),
    }),
    parse: body => {
      const [videoId, query] = body.split("?")
      const t = query?.startsWith("t=") ? Number(query.slice(2)) : undefined
      if (!videoId) {
        throw new Error("youtube_video: empty videoId")
      }
      if (t !== undefined && (!Number.isInteger(t) || t < 0)) {
        throw new Error("youtube_video: invalid t parameter")
      }
      return {
        kind: "youtube_video",
        videoId,
        ...(t !== undefined ? { t } : {}),
      }
    },
    serialize: v => `${v.videoId}${v.t !== undefined ? `?t=${v.t}` : ""}`,
  }

  it("registers and round-trips a custom kind", () => {
    registerRefKind(youtubeKind)
    const r = defineRef("youtube_video:dQw4w9WgXcQ?t=42")
    expect(r.kind).toBe("youtube_video")
    expect(r.compact).toBe("youtube_video:dQw4w9WgXcQ?t=42")
    const r2 = defineRef(r.compact)
    expect(r2.equals(r)).toBe(true)
  })

  it("rejects invalid kind names", () => {
    expect(() =>
      registerRefKind({
        ...youtubeKind,
        kind: "Invalid Kind!" as never,
      })
    ).toThrow(/Invalid kind name/)
  })
})
