/**
 * Pure wire-protocol + reconnect logic for the `/sessions/:id/pty` WebSocket
 * (see runtime/src/http-server.ts's handlePtyWebSocket doc comment for the
 * frame contract: `{kind:"data",b64}` | `{kind:"exit",exitCode,signal?}`
 * server→client, `{kind:"input",b64}` | `{kind:"resize",cols,rows}`
 * client→server). No `vscode`/`ws` import so this is directly unit-testable;
 * ptyMirror.ts is the thin glue that drives an actual socket + Pseudoterminal.
 */

export type PtyParsedFrame =
  | { kind: "data"; b64: string }
  | { kind: "exit"; exitCode: number; signal?: number }
  | { kind: "unknown" }

/** Parse one raw WS text message. Malformed JSON or an unrecognised shape is "unknown", never throws. */
export function parsePtyServerFrame(raw: string): PtyParsedFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "unknown" }
  }
  if (!parsed || typeof parsed !== "object") return { kind: "unknown" }
  const f = parsed as Record<string, unknown>
  if (f.kind === "data" && typeof f.b64 === "string") {
    return { kind: "data", b64: f.b64 }
  }
  if (f.kind === "exit" && typeof f.exitCode === "number") {
    return typeof f.signal === "number"
      ? { kind: "exit", exitCode: f.exitCode, signal: f.signal }
      : { kind: "exit", exitCode: f.exitCode }
  }
  return { kind: "unknown" }
}

/** `{kind:"data",b64}` payload → the UTF-8 text to hand to `Pseudoterminal.onDidWrite`. */
export function decodePtyData(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8")
}

/** Keystrokes/paste from `Pseudoterminal.handleInput` → the `{kind:"input",b64}` wire frame. */
export function encodeInputFrame(data: string): string {
  return JSON.stringify({ kind: "input", b64: Buffer.from(data, "utf8").toString("base64") })
}

/** `Pseudoterminal.setDimensions` → the `{kind:"resize"}` wire frame. */
export function encodeResizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ kind: "resize", cols, rows })
}

/**
 * Bounded reconnect backoff — mirrors the CLI's `runPtyAttach` policy
 * (packages/cli/src/commands/sessions.ts): 1s/2s/4s/4s/4s, five attempts.
 */
export const PTY_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 4_000, 4_000]

/** Delay (ms) for the given 0-based reconnect attempt, or `undefined` once attempts are exhausted. */
export function reconnectDelayMs(attempt: number): number | undefined {
  return PTY_RECONNECT_DELAYS_MS[attempt]
}

/**
 * Only an abnormal closure (1006 — the daemon process vanished mid-WS)
 * while the session is presumably still alive warrants a reconnect. A clean
 * close (1000, sent right after a `{kind:"exit"}` frame) or an app-level
 * close means the session is genuinely done — hammering it with retries
 * would be pointless.
 */
export function shouldReconnect(closeCode: number, attempt: number): boolean {
  return closeCode === 1006 && attempt < PTY_RECONNECT_DELAYS_MS.length
}
