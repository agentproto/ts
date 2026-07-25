---
"@agentproto/sandbox-box": patch
---

Retry transient failures in ascii.dev Box API calls with jittered exponential backoff. Network timeouts, FetchErrors, and 5xx/429 HTTP responses are retried up to 5 times; terminal errors (404, other 4xx) fail fast. All wrapped operations (get, remove, stop, resume) are idempotent on ascii.dev, so retrying is safe and prevents billable boxes from being left running on timeout.
