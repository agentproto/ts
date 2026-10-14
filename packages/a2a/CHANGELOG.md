# @agentproto/a2a

## 0.2.1

### Patch Changes

- 0f7808d: Sync the published package READMEs with the latest A2A push-notification and session-migration behavior.

## 0.2.0

### Minor Changes

- 22cfadd: A2A app tasks support push notifications: the four config methods store per-task webhooks, task updates are delivered to them as `StreamResponse` POSTs (also from `SendMessage`/`SendStreamingMessage`'s `configuration.pushNotificationConfig`), and the Agent Card advertises `capabilities.pushNotifications`.
- 8ad6546: Stream A2A tasks over SSE with `SendStreamingMessage` and `SubscribeToTask`, and advertise `capabilities.streaming` on the Agent Card.

## 0.1.0

### Minor Changes

- 3bab874: New `@agentproto/a2a` package: hand-written A2A (Agent2Agent, protocol 1.0) `AgentCard` types (`supportedInterfaces`, `securityRequirements`, oneof `SecurityScheme`) plus `buildAppAgentCard` / `buildDaemonAgentCard`. The runtime serves them at `GET /a2a/apps/:appId/.well-known/agent-card.json` (one card per installed app) and `GET /.well-known/agent-card.json` (daemon index aggregating every app that exposes something), behind the daemon's existing auth. Skills come only from an app's `exposes`; an app that declares none exposes nothing.
