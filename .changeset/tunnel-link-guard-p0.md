---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

`tunnel_create` is private by default: a signed-link access guard (random bearer token, 24h TTL by default, instant revoke, `X-Robots-Tag: noindex`, blocks `/@fs/` and source maps) now sits in front of every tunnel unless `public: true` is passed explicitly. The descriptor's new `url` field is the one to actually share — `publicUrl` alone now rejects every request without a valid token or cookie. New `tunnel_revoke` tool/route/CLI subcommand instantly invalidates the current link without stopping the tunnel.
