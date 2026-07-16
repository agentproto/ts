/**
 * Pure helpers for the attachment pipeline — no `vscode` import, so every
 * decision here is unit-testable without a webview or a live daemon.
 *
 * The one trap worth spelling out: WHERE pasted bytes land. A pasted
 * screenshot exists nowhere on disk, so the host copies it to a file and hands
 * the agent that file's absolute path (the agent's Read tool picks it up — this
 * was verified end to end: a claude-code session read a path OUTSIDE its cwd
 * with no permission block). The obvious place to put the file is the session's
 * own cwd, but that litters the user's git working tree with screenshots. So we
 * target the agentproto home instead (`$AGENTPROTO_HOME` or `~/.agentproto`) and
 * let the upload route append its own `.agentproto-attachments/` under it. The
 * file has to outlive the turn — the transcript stores the path, not the
 * bytes — which is also why it is NOT a tmp dir the OS can reap out from under a
 * replayed transcript.
 */

import { join } from "node:path"

/**
 * The `cwd` to hand `POST /files/upload` so the written file lands under the
 * agentproto home rather than in the caller's repo. The route appends
 * `.agentproto-attachments/` to whatever this returns
 * (`http-server.ts`: `join(cwd, ".agentproto-attachments")`), so pasted bytes
 * end up at `<home>/.agentproto-attachments/<name>` — outside any workspace.
 *
 * Mirrors the CLI's own home resolution (`$AGENTPROTO_HOME` wins, else
 * `~/.agentproto`) so a non-default home stays consistent across the two.
 */
export function resolveAttachmentsCwd(
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  const override = env["AGENTPROTO_HOME"]
  return override && override.length > 0 ? override : join(homeDir, ".agentproto")
}

/** Image mime → file extension, for a screenshot that arrives with no name of
 *  its own. Known image types map explicitly; anything else derives its
 *  extension from the mime subtype (so `image/x-foo` → `foo`) and falls back to
 *  `bin` when even that is empty. */
export function mimeToExtension(mime: string): string {
  const norm = mime.toLowerCase().split(";")[0]?.trim() ?? ""
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
    "image/tiff": "tiff",
    "image/heic": "heic",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
  }
  const hit = known[norm]
  if (hit) return hit
  const slash = norm.indexOf("/")
  if (slash >= 0) {
    let sub = norm.slice(slash + 1)
    const plus = sub.indexOf("+")
    if (plus >= 0) sub = sub.slice(0, plus)
    sub = sub.replace(/[^a-z0-9]/g, "")
    if (sub) return sub
  }
  return "bin"
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * A deterministic, sortable storage name for a pasted image:
 * `paste-YYYYMMDD-HHMMSS-<suffix>.<ext>`. The timestamp is UTC (so the name is
 * reproducible regardless of the host's timezone, and the tests aren't flaky);
 * `suffix` is a caller-supplied short token that keeps two pastes in the same
 * second from colliding on one filename. The route sanitizes the basename
 * again on its end, so this only has to be reasonable, not adversarial.
 */
export function buildAttachmentName(mime: string, date: Date, suffix: string): string {
  const stamp =
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `-${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}`
  return `paste-${stamp}-${suffix}.${mimeToExtension(mime)}`
}

/**
 * A webview posts pasted bytes as an `ArrayBuffer`; VS Code structured-clones
 * it across the boundary, and depending on the runtime the host may see it as
 * an `ArrayBuffer` or as a typed-array view over one. This accepts either so
 * the message guard doesn't have to bet on which — the alternative (base64 in
 * the JSON channel) is the transcript-bloat wound this whole design avoids.
 */
export function isBinaryPayload(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

/** Normalize whichever binary shape crossed the webview boundary into a single
 *  `Uint8Array` the upload body and the size check can both use. A view is
 *  wrapped over its exact window (offset+length), never the whole backing
 *  buffer. */
export function toUint8(payload: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
}

/** The daemon route's own hard cap — sending more just earns a 413, so the
 *  extension pre-checks and refuses with a friendly message instead. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
/** Above this a single paste/drop is almost always a mistake (a huge file
 *  landing in the attachments dir) — warn, but don't block. */
export const WARN_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** More than this many attachments in one turn is nearly always accidental and
 *  turns the prompt into path soup. Soft cap: the (N+1)th is refused with a
 *  message, the first N stay. */
export const ATTACHMENT_COUNT_CAP = 10

export type SizeVerdict = { verdict: "ok" | "warn" | "reject"; message?: string }

/** Decide what to do with a blob before uploading it — reject over the route's
 *  cap (Decision G: don't eat a 413), warn over the practical ceiling, else ok.
 *  Pure so the thresholds are asserted, not guessed. */
export function classifyAttachmentSize(byteLength: number): SizeVerdict {
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      verdict: "reject",
      message: `That file is ${formatMiB(byteLength)} — over the ${formatMiB(MAX_ATTACHMENT_BYTES)} limit. It was not attached.`,
    }
  }
  if (byteLength > WARN_ATTACHMENT_BYTES) {
    return {
      verdict: "warn",
      message: `That file is ${formatMiB(byteLength)} — large for an attachment, but it was attached.`,
    }
  }
  return { verdict: "ok" }
}

function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024)
  return `${mib >= 10 ? Math.round(mib) : Math.round(mib * 10) / 10} MiB`
}

/**
 * Parse a drag-drop `text/uri-list` (or VS Code's `application/vnd.code.uri-list`)
 * into absolute file paths. A file dragged FROM the VS Code Explorer arrives as
 * a `file://` URI with a real, already-on-disk path — so it needs no upload
 * (Decision A1), unlike a file dragged from the OS which arrives as raw bytes.
 * Comment lines (`#…`) and non-`file:` schemes are skipped.
 */
export function parseUriList(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    let url: URL
    try {
      url = new URL(line)
    } catch {
      continue
    }
    if (url.protocol !== "file:") continue
    // decodeURIComponent turns %20 etc. back into a real path; url.pathname is
    // already percent-decoded per the URL spec on read, but be explicit.
    out.push(decodeURIComponent(url.pathname))
  }
  return out
}

/**
 * Storage name for a file dragged from the OS (which DOES carry its own name,
 * unlike a clipboard paste). Keeps the human stem so the attachments dir stays
 * legible, but appends a short suffix so two drops of `photo.png` don't clobber
 * each other on disk. Extension comes from the name, falling back to the mime.
 */
export function buildDroppedName(originalName: string, mime: string, suffix: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? originalName
  const dot = base.lastIndexOf(".")
  const rawStem = dot > 0 ? base.slice(0, dot) : base
  const rawExt = dot > 0 ? base.slice(dot + 1) : ""
  const stem = rawStem.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100) || "file"
  const ext = (rawExt.replace(/[^A-Za-z0-9]/g, "") || mimeToExtension(mime)).slice(0, 12)
  return `${stem}-${suffix}.${ext}`
}
