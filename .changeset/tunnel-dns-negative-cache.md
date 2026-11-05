---
"@agentproto/runtime": patch
---

Fix tunnel health probes caching an NXDOMAIN for fresh hostnames: wait for public DNS-over-HTTPS visibility before the first probe, then probe the pinned DoH address instead of the system resolver.
