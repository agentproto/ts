---
"@agentproto/runtime": patch
---

Add DNS-rebinding defense to HTTP server. Requests from the loopback interface now require a loopback Host header (127.0.0.1, localhost, or [::1]), preventing DNS-rebinding attacks that point malicious domains at 127.0.0.1 while retaining their own hostname in the HTTP Host header. Complements existing Origin-based CSRF guards with a second layer of protection. The `/health` endpoint remains publicly accessible as a harmless uptime probe.
