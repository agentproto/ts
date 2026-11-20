# antigravity — ACP wire profile

AIP-44 ACP profile for Google Antigravity's first-party ACP server. The agent
side is the `agy` binary itself, spawned as `agy acp` (NDJSON JSON-RPC 2.0 over
stdio, the default transport). Install: `curl -fsSL
https://antigravity.google/cli/install.sh | bash` (drops `agy` in
`~/.local/bin`).

Verified on **agy 1.5.13** (2026-11-20), `protocolVersion` 1.

## Lifecycle

| Method           | Behaviour                                                                 |
| ---------------- | ------------------------------------------------------------------------- |
| `initialize`     | Returns `agentInfo` "Antigravity ACP Server", `loadSession`, `sessionCapabilities {resume, close, load, list, additionalDirectories}`, `promptCapabilities {image: true, audio: false, embeddedContext: true}` and `authMethods`. |
| `authenticate`   | Methods: `oauth-personal` (Google), `oauth-business` (Gemini Enterprise), `gemini-api-key`, `agent-platform` (ADC). Not exercised by this adapter. |
| `session/new`    | Without a cached login: error `-32000 "Authentication required"` (verified). |
| `session/load`   | Advertised; backs the `native-resume` continuation (not verified live). |
| `session/prompt` | Not verified live (no Google login on the test host).                     |

## Spawn flags worth knowing

`agy acp` accepts `--agent`, `--add-dir`, `--sandbox`,
`--dangerously-skip-permissions`, `--process-per-session`, `--login` (run the
Google login interactively, then exit). There is no `--model` or `--effort`
flag on the ACP server: model selection is session-side, not an argv option.

## Known gaps

- End-to-end prompt turn unverified: needs a one-time interactive Google
  sign-in (`agy` or `agy acp --login`) on the host.
- `agy` is not on npm; the curl installer is the only documented channel.
