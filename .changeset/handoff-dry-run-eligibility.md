---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Sessions handoff/profiles fixes (issue: pygmalion brain → Mistral Large 4.0 handoff, 2026-11-21):

- `sessions handoff --dry-run` now validates the eligibility chain the real handoff enforces — the target harness resolves, and the access profile the successor would use (--profile override or the source's inherited wallet) is eligible for the target adapter+route and allows the model — and fails EARLY with the same error code and message the real run gives, before building the checkpoint preview.
- `access_profile_ineligible` refusals now SUGGEST the fix: which stored profiles would be eligible for the target adapter+route (and would allow the requested model), so the caller no longer has to guess the --profile value.
- `agentproto auth status` lists credential-backed profiles (api-key, no login — e.g. mistral-vibe-pro, mistral-api): a `credentialProfiles` array in --json and a table section naming the flag that uses them. Login-backed `profiles` rows are unchanged.
- `agentproto models <adapter>` reads the merged native + generic-ACP listing, so a curated generic-ACP harness (mistral-vibe, kimi-cli, …) lists its models instead of coming back empty; per-model provider declarations decide runnability (mistral-vibe's hosted z-ai ids bill through mistral).
- `sessions start` accepts `--profile` (short alias of `--access-profile`); `sessions handoff` accepts `--access-profile` (long alias of `--profile`); conflicting values are exit 2 before any daemon call. Handoff/checkpoint errors frame the daemon's structured access_profile_* refusals with the same actionable hint `sessions start` prints.
