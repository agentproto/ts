---
"@agentproto/cli": minor
---

Doctor node/adapter mismatch check (F4): the daemon step now compares the Node
binary the daemon runs under (`/health` `info.node`) against this CLI's Node
and, when the two differ, asks each Node's global install whether it can see
the catalog's `@agentproto/adapter-*` packages (same `createRequire` anchor
the daemon's manifest-loader uses). Any adapter this CLI's Node resolves but
the daemon's does not warns with the exact reinstall command
(`npm i -g @agentproto/adapter-<slug> …`) — the failure mode where global
adapters installed under one Node (nvm/fnm switch) are invisible to the
daemon's Node, so `agent_start` fails `adapter "<x>" could not be resolved`
while the packages look installed. Same Node, an older daemon without the
`node` field, or no divergence in what resolves reports nothing.
