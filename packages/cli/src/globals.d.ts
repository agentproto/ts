/** Injected by tsup `define` at build time from package.json#version. */
declare const __CLI_VERSION__: string

/** Injected by tsup `define` at build time: `git rev-parse --short HEAD`
 *  of the checkout the dist was built from, or "" when git was
 *  unavailable (e.g. a tarball rebuild). */
declare const __CLI_BUILD_SHA__: string

/** Injected by tsup `define` at build time: ISO timestamp of the build.
 *  With `__CLI_BUILD_SHA__` this is the daemon's "build number" — the
 *  version string alone can't distinguish a workspace dist from the
 *  published tarball of the same release. */
declare const __CLI_BUILT_AT__: string

/** `qrcode-terminal` ships no types. We only use `generate`. */
declare module "qrcode-terminal" {
  export function generate(
    input: string,
    opts: { small?: boolean },
    cb: (output: string) => void,
  ): void
  const _default: { generate: typeof generate }
  export default _default
}
