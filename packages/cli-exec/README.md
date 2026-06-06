# @agentproto/cli-exec

Minimal helpers for driving a CLI in one-shot mode — spawn a command, feed a
prompt over stdin, capture stdout, with a hard timeout and `AbortSignal`
support. Plus a tolerant parser for agent CLIs that emit a `--output-format
json` result envelope.

Zero runtime dependencies (node builtins only). Shared by anything that drives
a headless agent CLI (`claude --print`, `gemini`, `goose`, …) so the spawn glue
lives in one place instead of being copied per call site.

```ts
import { spawnWithStdin, parseClaudeJsonOutput } from "@agentproto/cli-exec"

const stdout = await spawnWithStdin({
  command: "claude",
  args: ["-p", "--output-format", "json"],
  stdin: "Summarize this in one sentence: …",
  timeoutMs: 120_000,
})
const text = parseClaudeJsonOutput(stdout) ?? stdout
```

## API

### `spawnWithStdin(options): Promise<string>`

| option      | default            | meaning                                              |
| ----------- | ------------------ | ---------------------------------------------------- |
| `command`   | —                  | executable to invoke (must be on PATH)               |
| `args`      | `[]`               | argv; the prompt is fed over stdin, not as an arg    |
| `stdin`     | —                  | text written to the child's stdin, then closed       |
| `cwd`       | `process.cwd()`    | working directory                                    |
| `timeoutMs` | `90000`            | hard timeout; the child is killed and the call rejects |
| `signal`    | —                  | abort the call (kills the child)                     |
| `killSignal`| `"SIGTERM"`        | signal used on timeout/abort                         |

Resolves with captured stdout on exit code `0`; rejects on non-zero exit (with
trimmed stderr), spawn error, timeout, or abort.

### `parseClaudeJsonOutput(stdout): string | null`

Parses a `claude --output-format json` envelope and returns its `result`
string, or `null` if the output isn't that shape (caller falls back to raw
stdout).
