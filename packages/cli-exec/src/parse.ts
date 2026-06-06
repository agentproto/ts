/**
 * Parse a `claude --output-format json` response: return the `result` field as
 * the model's text, or null if the JSON isn't that shape (caller falls back to
 * raw stdout). The same envelope is emitted by several agent CLIs in JSON mode.
 */
export function parseClaudeJsonOutput(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "result" in parsed &&
      typeof (parsed as { result: unknown }).result === "string"
    ) {
      return (parsed as { result: string }).result
    }
    return null
  } catch {
    return null
  }
}
