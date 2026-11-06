---
"@agentproto/runtime": patch
---

DoH responses with a non-success DNS status (1 FORMERR, 2 SERVFAIL, 5 REFUSED, and any other RCODE except 0 NOERROR and 3 NXDOMAIN) are now treated like an unreachable resolver instead of an authoritative empty answer. When every endpoint fails this way `resolveViaDoh` returns `unreachable`, so tunnel probes fall back to the system resolver instead of reporting the hostname as not yet visible.
