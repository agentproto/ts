# Note: unimplemented defects A (auth-profile bridge) and C (sandbox topology visibility)

Branch `fix/e2b-auth-profile-bridge` landed defect B only
(orchestrator-reach fix + role-disposition tests). A and C did not fit the
time box (2026-10-21) as anything other than a half-implement, which the
mission forbids for C and which would be unsafe for A (auth surface).

## Defect B caveat — version skew

The host-composed supervisor prompt promises the box-side delegation surface.
A box daemon whose `serve` predates the orchestrator sub-gateway refuses the
forwarded `orchestrator` request (`orchestrator_not_enabled`, surfaced as
`sandbox_proxy_failed`) — fail-closed, but the host prompt has already
promised the surface. Boxes install `@agentproto/cli@<cliVersion pin>`; keep
that pin >= the controller runtime when orchestrating inside boxes.

## Defect A — selective sandbox auth-profile bridge (NOT implemented)

Anchor points (surveyed, none edited):

- `session-spawn.ts:651` `resolveAccessProfileAuth` — resolves
  `access.profileRef` host-local only.
- `session-spawn.ts:6715` `sandboxAuthFromResolved` — flattens the resolved
  spec to `{mode, apiKey|token, credentialEnv, extraEnv, isolateDataHome}`;
  only the root spawn's single selected credential crosses the boundary.
- `session-spawn.ts:6035` `withSandboxAuthAutoPassthrough` — the existing
  credential cross-boundary channel (env slug via `resolveSandboxSecretsEnv`,
  `packages/sandbox/src/agent-session-host.ts:540-557`, materialized by
  `packages/sandbox-box/src/provider.ts:228-269` as `/etc/agentproto/agentproto.env`
  mode 0600).
- Box child spawns go through the BOX daemon's own `agent_start`
  (`session-spawn.ts:6392-6435` today for role/orchestrator), which has no
  `access.profileRef` allowlist surface.

Implementation outline for whoever picks this up (from the audit, matching
the mission):

1. Add `authProfiles?: string[]` (least-privilege allowlist of BRIDGED extra
   profile ids) to the sandbox spawn input schema and `bootSandboxAgentSession`
   opts; implicitly include the root spawn's resolved `authProfileRef`.
2. Host-side validation, fail closed: every allowlisted id must exist and be
   enabled (`getAuthProfile`); unknown id is a hard spawn error, and a
   nested/box child naming an undeclared profile must get a distinct
   `access_profile_not_allowed` failure — no silent fallback to the implicit
   box credential.
3. On box provisioning, materialize for each bridged profile:
   - metadata-only `AuthProfile` entry (endpoint/routes/models-costBudget/label/
     subaccount pin) written to the BOX-local `~/.agentproto/auth-profiles.json`
     (mode 0600) with a BOX-LOCAL `credentialRef`;
   - the resolved credential value written to the box's OWN credential store /
     keychain through the boot-exec path, never through spec config, session
     descriptors, logs, events, checkpoints, or error text;
   - source-backed / subaccount-pinned profiles must be resolved host-side to a
     SCOPED credential first (`sandboxSubaccountScope` handling,
     `session-spawn.ts:6737`), never the raw parent secret ref.
4. Registry the ephemeral box-local credentials for teardown: root proxy
   teardown (`sandbox-agent-session-proxy.ts` close/stop path) must destroy
   them (and the box-local profile entries die with the box filesystem).
5. Secret-scan test modeled on `sandbox-auth-autopassthrough.test.ts:195`
   (sk-SENTINEL scan over spec JSON, descriptors, session rows, ledger rows,
   composed prompts, events, error messages, and the box auth-profiles.json
   being refs-only).

Required tests (from the mission) that DO NOT EXIST yet — all must fail on the
pre-A code:
- nested box child selects a second explicitly bridged profile;
- undeclared profile name is refused (`access_profile_not_allowed`);
- root teardown destroys descendants and ephemeral credentials;
- secret scan over persisted/returned structures.

## Defect C — remote topology visibility (NOT implemented)

- `packages/runtime/src/session-tools.ts:571-608` and `:3889-3925`
  `buildSessionTree` builds session_tree from the host registry index only;
  box-local children (spawned through `/mcp/orchestrator` inside the box) are
  invisible, and the host root shows `isOrchestrator: false`.
- Smallest safe projection (per audit): read-only, pull-based merge — for each
  sandbox proxy node call the BOX daemon's own `session_tree` via its
  `mcpUrl` + `authHeaders` (`HarnessClient.callTool`), attach under a
  `remoteChildren` / `origin: "sandbox"` marker, compute `isOrchestrator`
  over the merged index. Projected nodes MUST NOT become host registry rows,
  `session_list` entries, nor be kill/agent_prompt targets (nearest action:
  attach through the host proxy session).
- Do not implement until A lands: both touch the same spawn-path shapes, and
  a tree projection without the auth-profile bridge risks telling operators
  things the credential story does not back.
