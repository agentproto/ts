import { describe, expect, it } from "vitest"

import {
  changelogHeading,
  modalityOf,
  outputPathOf,
  vendorOf,
} from "../modality-output.mjs"

const SRC = "/repo/packages/model-catalog/src"

describe("run-all per-modality output naming", () => {
  it("keeps the historical LLM output path byte-for-byte", () => {
    expect(modalityOf("sync-openai.mjs")).toBe("llm")
    expect(vendorOf("sync-openai.mjs")).toBe("openai")
    expect(outputPathOf("sync-openai.mjs", SRC)).toBe(
      `${SRC}/llm/openai-pricing.generated.ts`
    )
    expect(changelogHeading(modalityOf("sync-openai.mjs"), vendorOf("sync-openai.mjs"))).toBe(
      "### llm:openai"
    )
  })

  it("routes a media script to its modality directory", () => {
    expect(modalityOf("sync-replicate.mjs")).toBe("image")
    expect(outputPathOf("sync-replicate.mjs", SRC)).toBe(
      `${SRC}/image/replicate-pricing.generated.ts`
    )
    expect(changelogHeading("image", "replicate")).toBe("### image:replicate")
  })
})
