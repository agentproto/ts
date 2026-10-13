---
"@agentproto/sandbox": minor
"@agentproto/sandbox-e2b": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

`sandbox_exec` can take secrets without the caller holding them: `envProfiles: { ENV_NAME: authProfileId }` has the daemon read the profile's credential (keychain, or its sub-account provider) into the command's env. Exec errors are now cut to ~200 chars of the command (`…(N chars)`) and resolved secrets are redacted from errors, stdout and stderr; commands over 16 KB / env over 32 KB are rejected with an actionable error, and an optional `files` input uploads scripts via the new optional `BootedSandbox.writeFile` (implemented for e2b). New `agentproto sandbox exec` CLI and daemon route `POST /sandboxes/exec`, whose exit code is the box command's exit code.
