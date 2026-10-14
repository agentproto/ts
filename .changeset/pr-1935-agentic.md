---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"agentproto-vscode": patch
---

restartPolicy.on gains "sandbox-gone": a dead box session whose box is gone moves to a fresh box (runtime), new daemon.sandboxGoneRestartDefault wired through `serve` (cli), and the vscode RestartPolicy type accepts the new value.
