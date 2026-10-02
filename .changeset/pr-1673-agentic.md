---
"@agentproto/runtime": patch
---

fix(webhook-egress): `ssrfFetch` now defaults the HTTP `Host` header to the original hostname (with `:port` on non-default ports) instead of letting the socket derive it from the connect IP, and the test seam receives the same final wire headers. Prevents name-based vhosts (e.g. CF edge / cloudflared) from answering a literal-IP `Host` with 403/421, which mis-categorised subscribers as `non_2xx` instead of `challenge_failed`. Explicit caller `Host` headers are preserved verbatim.
