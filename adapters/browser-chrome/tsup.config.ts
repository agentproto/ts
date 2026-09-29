import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-browser-chrome
 * System Chrome provider: fresh dedicated profile dir, CDP attach, granted-cookie injection.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "ws", "@agentproto/driver-browser"],
  noExternal: [],
})
