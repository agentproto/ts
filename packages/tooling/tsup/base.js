import { defineConfig } from "tsup"

/**
 * Reusable tsup base config for agentproto packages.
 *
 * Why DTS without `resolve: true`: tsup bundles d.ts via rollup-dts.
 * Resolving inlines types from `node_modules` and adds 30s–5min per
 * package; dropping it cuts most packages from ~30–100s to under 5s
 * while keeping d.ts paths aligned with tsup's flattened entry names.
 * Packages that need full d.ts resolution should set `dts: false`
 * here and run `tsc -p tsconfig.build.json` after tsup.
 */
export const createTsupConfig = (options = {}) => {
  const { banner = "", external = [], ...customOptions } = options

  return defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    minify: false,
    target: "es2022",
    outDir: "dist",
    tsconfig: "./tsconfig.json",
    watch: process.env.NODE_ENV === "development",
    external,
    banner: banner ? { js: banner } : undefined,
    outExtension({ format }) {
      return {
        js: format === "cjs" ? ".js" : ".mjs",
      }
    },
    esbuildOptions(options) {
      options.sourcesContent = true
    },
    treeshake: true,
    ...customOptions,
  })
}

export default createTsupConfig()
