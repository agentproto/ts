---
'@agentproto/skill-pack-agentproto': minor
---

Rewrite the agentproto-plugin skill pack as a 3-layer family: an L0 master map (`agentproto`), 18 L1 primitives (`ap-*`) that each teach one daemon action, 4 L2 groupers that route to primitives without duplicating mechanics, and 6 L3 end-to-end playbooks (`pb-*`). Removes the old flat set (adapter-setup-kit, agent-session-orchestration-agentproto, durable-supervision, hermes-headless-background, light-coder-orchestration, nested-orchestration, supervisor-session). Keeps `agentproto-apps` (app-dir anatomy / `app serve` UI bridge / `app_data_migrate` / smoke-test recipe are not covered by the new primitives) and `agentproto-llm-endpoint` (its CLI `--base-url`/`--auth-token` guidance matches the current CLI; the rewrite's copy claims those flags don't exist). Ported from the already-reviewed rewrite in agentik-studio (agentik-studio#86).
