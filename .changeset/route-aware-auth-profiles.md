---
"@agentproto/auth": patch
"@agentproto/cli": patch
---

Let an auth profile declare additional billing `routes` it serves beyond its
primary `endpoint` (e.g. one OpenCode key billed on both the `opencode-go` Go
route and the `opencode` Zen route). The eligibility predicate admits the
profile on any declared route; absent `routes` behaves exactly as before.
`auth profile create` gains a repeatable `--route <route>` flag, and create
input validates/normalizes/dedupes the list. This is the portable-key
equivalent of the `opencode-console` org-login cross-route rule, and mirrors
the additive, back-compatible shape of `disabled`/`models`.
