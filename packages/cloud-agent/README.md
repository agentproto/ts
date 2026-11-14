# @agentproto/cloud-agent

The AIP-66 managed cloud agent host surface (`cloud-agent/v1`):

- `CLOUD_VENDORS` and `resolveCloudSpawn`: the vendor registry and the pure spawn resolver that refuses unknown vendors and inapplicable spawn fields by name, before any side effect
- `meta.cloud` encoding/decoding and the vendor harness label helpers
- the relay's session-meta side file (`readCloudSessionMetaFile`, `watchCloudSessionMeta`) and the resume-side vendor id fallback (`resolveCloudResumeId`)
- `cloudRepoSpawnEnv` for a workspace with a declared remote, taking the runtime's remote validators as a port

The vendor adapter itself (`claude-code-cloud`) stays in `adapters/`.
