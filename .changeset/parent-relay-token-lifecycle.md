---
"@agentproto/runtime": minor
---

Give the parent-relay token (box `message_parent` relayed to the host parent,
configured with `AGENTPROTO_PARENT_RELAY_URL`) a full lifecycle.

The host keeps only the token's SHA-256 hash, persisted (0600) in
`parent-relay-grants.json` next to the sessions state and reloaded at boot, so
a host daemon restart keeps live relays. A grant slides on every successful
use and is renewed by a periodic sweep while both its box session and its
parent are live; it is revoked when either session ends, is archived or
forgotten, when the box boot fails, and by the sweep once either session is
dead; expired grants are pruned. Restarting the box session (live-box
re-attach or fresh box) re-mints the grant and forwards the remote parent
again. The box keeps the raw token in memory only. `remoteParent` on
`agent_start` is daemon-internal: a session caller that supplies it is
refused, and cron/routine agent jobs strip it.
