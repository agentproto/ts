import { describe, expect, it } from "vitest"

import {
  changelogHeading,
  diffIds,
  modalitiesOf,
  outputsOf,
  vendorOf,
} from "../modality-output.mjs"

const SRC = "/repo/packages/model-catalog/src"

describe("run-all per-modality output naming", () => {
  it("keeps the historical LLM output path byte-for-byte", () => {
    expect(modalitiesOf("sync-openai.mjs")).toEqual(["llm"])
    expect(vendorOf("sync-openai.mjs")).toBe("openai")
    expect(outputsOf("sync-openai.mjs", SRC)).toEqual([
      { modality: "llm", path: `${SRC}/llm/openai-pricing.generated.ts` },
    ])
    expect(changelogHeading("llm", vendorOf("sync-openai.mjs"))).toBe("### llm:openai")
  })

  it("routes a media script to every modality directory it writes", () => {
    expect(outputsOf("sync-replicate.mjs", SRC)).toEqual([
      { modality: "image", path: `${SRC}/image/replicate-pricing.generated.ts` },
      { modality: "video", path: `${SRC}/video/replicate-pricing.generated.ts` },
    ])
    expect(changelogHeading("image", "replicate")).toBe("### image:replicate")
    expect(changelogHeading("video", "replicate")).toBe("### video:replicate")
  })

  it("diffs ids per output, so a video-only addition is reported", () => {
    const imageBefore = new Set(["replicate:a/img"])
    const videoBefore = new Set(["replicate:a/vid"])
    const imageAfter = new Set(["replicate:a/img"])
    const videoAfter = new Set(["replicate:a/vid", "replicate:b/new-vid"])
    expect(diffIds(imageBefore, imageAfter)).toEqual({ added: [], removed: [] })
    expect(diffIds(videoBefore, videoAfter)).toEqual({
      added: ["replicate:b/new-vid"],
      removed: [],
    })
    expect(diffIds(videoAfter, videoBefore)).toEqual({
      added: [],
      removed: ["replicate:b/new-vid"],
    })
  })
})
