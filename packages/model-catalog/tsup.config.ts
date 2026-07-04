import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/model-catalog v0.1.0
 * Unified model catalog: LLM, image, video, audio entries + cost dispatcher + picker.
 * Zod-only OSS core; @agstudio/model-catalog layers billing/access/BYOK on top.
 */`,
  entry: {
    index: "src/index.ts",
    "schema/index": "src/schema/index.ts",
    "schema/voice": "src/schema/voice.ts",
    "llm/index": "src/llm/index.ts",
    "image/index": "src/image/index.ts",
    "video/index": "src/video/index.ts",
    "audio/index": "src/audio/index.ts",
    "voice/index": "src/voice/index.ts",
    "providers/index": "src/providers/index.ts",
    "curation/index": "src/curation/index.ts",
    "cost/index": "src/cost/index.ts",
    "pricing/index": "src/pricing/index.ts",
    "byok/index": "src/byok/index.ts",
    "access/index": "src/access/index.ts",
    "picker/index": "src/picker/index.ts",
    "overlay/index": "src/overlay/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod"],
  noExternal: [],
})
