/** Injected by tsup `define` at build time from package.json#version. */
declare const __CLI_VERSION__: string

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
