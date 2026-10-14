---
"@agentproto/acp": patch
"@agentproto/driver-agent-cli": patch
---

Read opencode's native session modes from the `category:"mode"` config option
it actually advertises (opencode 1.19 leaves the ACP `modes` field undefined), so
`availableModes` is no longer empty: canonical postures now resolve to a real
native mode (`default`→`build`, `plan`→`plan`) and switch live via
`session/set_mode`, instead of silently degrading to an advisory
prompt-injection preamble. Also re-assert the requested model/effort/mode on
`loadSession` (native-resume): a restarted opencode session used to drop the
requested model and run its own default `opencode/big-pickle` (a per-IP
rate-limited free id) while agentproto still reported the requested model and
route. The existing derived-from-model spawn guard now covers resumes too, since
`loadSession` records `modelApplyRejection`.
