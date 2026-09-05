---
"@agentproto/cli": minor
"create-agentproto-app": patch
---

`agentproto app init <template> [dir]` — scaffold an app from a template
(react-ts | vanilla | book | trame) by wrapping `create-agentproto-app`'s
`scaffoldApp`; the new `trame` template emits the minimal AIP app trame
(one agent, one workflow with a harness-pinned agent step + gate, a
single-file UI stage board, an example gate, the verify umbrella, the
data-plane key dictionary, and a node:test suite).

`agentproto app validate [dir] [--json]` — check an app against the
loaders: `loadAppHandle`, every declared workflow via `loadWorkflow`,
`ui.tools` entries against the known daemon tool surface (plus `app_*`),
`data/DATA.md` presence when `data.dir` is declared, and the APP.md
`verify.command` run argv-split (no shell) from the app dir with its exit
code propagated.
