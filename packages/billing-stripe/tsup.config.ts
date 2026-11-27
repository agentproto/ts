import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/billing-stripe
 * Stripe settlement provider for @agentproto/billing: webhook verification, mode guard, money facts.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["stripe"],
  noExternal: [],
})
