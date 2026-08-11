---
"@agentproto/adapter-codex": patch
"@agentproto/adapter-mastra-agent": patch
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Three adapter infrastructure fixes:

1. Codex model list expanded from 8 to ~40 models — covers GPT-5 family
   (5/5.1/5.2/5.4/5.5), GPT-5.6 (luna/sol/terra), GPT-4.1/4o, and
   o-series reasoning models (o1/o3/o4-mini).

2. CLI `agentproto install <slug>` now drives a generic ACP agent's
   `install_hint` through the shared hint parser (new `install-hint.ts`
   module, extracted from `install-driver.ts` to break a circular dep).
   The `vendored` install step checks if the binary is already on PATH,
   runs npm/uv/pip/brew/cargo/go hints when recognized, and fails loud
   with an actionable message otherwise.

3. `binOnPath` in `acp-generic.ts` now checks well-known package-manager
   install directories (`~/.local/bin`, `~/.cargo/bin`, `~/go/bin`,
   `/opt/homebrew/bin`, `/usr/local/bin`) as a fallback when PATH hasn't
   picked them up yet — fixes adapters installed via `uv tool install`
   not showing as "available" until the daemon restarts.

Also: modelDerivedApiKey provider resolution for adapters like mastra-agent.
