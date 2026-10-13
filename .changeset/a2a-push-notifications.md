---
"@agentproto/runtime": minor
"@agentproto/a2a": minor
---

A2A app tasks support push notifications: the four config methods store per-task webhooks, task updates are delivered to them as `StreamResponse` POSTs (also from `SendMessage`/`SendStreamingMessage`'s `configuration.pushNotificationConfig`), and the Agent Card advertises `capabilities.pushNotifications`.
