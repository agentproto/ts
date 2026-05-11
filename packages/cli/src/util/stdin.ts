/**
 * Read piped stdin to a string. Returns null if stdin is a TTY (no pipe).
 * Used by `agentproto run` to accept prompts via:
 *   echo "summarise this repo" | agentproto run claude-code
 */

export async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString("utf8").trim()
  return text.length > 0 ? text : null
}
