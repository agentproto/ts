---
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
---

Device session mirroring (BOOTSTRAP P7, refs #1637): a controller spawning into
`sandbox: "device:<fp|name>"` can now BOTH address the host conversation and
read turns that happened on the host.

- P7a: a device spawn stamps `hostSessionId` + `hostFingerprint` onto the
  controller descriptor (the device provider resolves the paired host's real
  fingerprint even for a name target); `device_prompt` (tool + REST route)
  accepts a controller session id and substitutes its mapped host id when the
  exact id 404s, with an actionable error naming the host when both fail; the
  fields ride `session_list`'s compact projection.
- P7b: read-time device-mirror (`device-mirror.ts`) — the session READ paths
  (`GET /sessions/:id` and its `/output`, `/events`, `/export`,
  `/conversation` twins, plus the `agent_output` tool) sync host turns into the
  controller transcript before reading, tagged `origin: "device"` + `hostSeq` +
  `sourceRef: "device:<fp>"`, with a restart-safe dedup cursor and a
  `mirrorError` marker when the host is unreachable. Consumes EXISTING host
  endpoints only; hosts older than the id-mapping fields keep today's behaviour.
- Minor (not patch) because runtime adds new exports
  (`promptDeviceSession`, `syncDeviceMirror`, …) and sandbox adds the optional
  `device?.fingerprint` field on `BootedSandbox`.
