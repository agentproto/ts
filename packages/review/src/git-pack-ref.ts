/**
 * The one parser for a `git+https://<url>#<40-hex-sha>` pack reference
 * (AIP-62 §Review packs). The manifest parser validates a ref with it and the
 * runtime's pack loader clones with it, so the two cannot disagree on where
 * the pin starts: at the FIRST `#`. A url therefore contains no `#` (nor any
 * whitespace) — the same shape `REVIEW.schema.json` accepts for `uses[].pack`.
 */

export class GitPackRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitPackRefError"
  }
}

const GIT_PACK_REF = /^git\+(https:\/\/[^\s#]+)#([0-9a-f]{40})$/

/** Split a `git+` pack ref into its clone url and pinned commit sha. Throws
 *  {@link GitPackRefError} for a non-https transport (`ssh://`, `file://`,
 *  `ext::`, plain `http://` — `ext::` runs arbitrary commands, and a url that
 *  always starts with `https://` can never be read as a `git clone` flag) and
 *  for anything not pinned to a full 40-hex sha. */
export function parseGitPackRef(ref: string): { url: string; sha: string } {
  if (!ref.startsWith("git+https://")) {
    throw new GitPackRefError(
      `git pack ref '${ref}' must use git+https:// — other git transports (ssh://, file://, ext::, plain http://) are not accepted`,
    )
  }
  const m = GIT_PACK_REF.exec(ref)
  if (!m) {
    throw new GitPackRefError(
      `git pack ref '${ref}' must be pinned to a full 40-hex commit sha (git+https://<url>#<sha>) — ` +
        `a floating branch, tag, or short sha is not reproducible; the url itself may not contain whitespace ` +
        `or '#' (the pin starts at the first '#')`,
    )
  }
  return { url: m[1]!, sha: m[2]! }
}
