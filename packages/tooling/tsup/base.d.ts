import type { Options } from "tsup"

/**
 * Reusable tsup base config for agentproto packages. Returns the
 * result of `tsup.defineConfig(...)` so package-level `tsup.config.ts`
 * can compose without re-declaring every default.
 */
export declare const createTsupConfig: (options?: Options) => ReturnType<
  typeof import("tsup").defineConfig
>

declare const _default: ReturnType<typeof createTsupConfig>
export default _default
