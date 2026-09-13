# Google Antigravity — Sandbox

Antigravity's `agy` is a terminal coding agent. In headless mode its tool
execution is governed by policy, not interactive prompts:

- **Permission mode.** Headless runs have no interactive prompt, so a tool that
  would normally ask for confirmation is *soft-denied*: the run continues, exits
  `0`, and prints a notice to stderr naming the tool and how to allow it.
  Reading and writing files inside the active workspace is auto-allowed; actions
  like shell commands default to *Ask* and are soft-denied unless granted.
- **Granting tools ahead of time.** Add `action(target)` rules under
  `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`, e.g.
  `"command(git)"`, `"command(npm run (build|lint|test))"`,
  `"write_file(src/)"`.
- **Bypass (use with care).** The adapter's `dangerously_skip_permissions`
  option maps to `agy --dangerously-skip-permissions`, which auto-approves
  **every** tool call (file writes and command execution). Prefer scoped
  `permissions.allow` rules unless you fully trust the prompt and environment.
- **Terminal sandbox.** The `terminal_sandbox` option maps to `agy --sandbox`,
  running the agent with agy's own terminal sandbox restrictions enabled.

## Headless mode

When invoked with `-p "<prompt>" --output-format stream-json`, `agy` runs as a
non-interactive NDJSON event stream suitable for programmatic consumption. The
stream begins with one `init` event, emits any number of `step_update` events
(text deltas, tool calls, checkpoints), and ends with exactly one `result`
event carrying the terminal `status` and total token `usage`.

## ACP

Antigravity exposes **no ACP mode** (open feature request
`google-antigravity/antigravity-cli#31`). This adapter therefore uses the
print/headless protocol arm, not ACP.
