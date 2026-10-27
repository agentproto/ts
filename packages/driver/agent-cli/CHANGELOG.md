# @agentproto/driver-agent-cli

## 2.16.0

### Minor Changes

- 16d10ed: Add an internal data-format id (`AGENCIES_FORMAT`, `AGENT_CLI_FORMAT`), so the packages no longer present their format ids as AIP registry spec names. The legacy `SPEC_NAME` export is retained for compatibility and is now deprecated; it remains a legitimate pending registry-name deviation until it is removed.
- 7a90c4b: AIP-45 step 2 of 2: the runner formerly published as `@agentproto/driver-agent-cli` now ships as `@agentproto/harness` (on npm since 2.15.0). It gains `defineHarness`, an alias of `defineAgentCli` registered as the AIP-70 `harness/v1` entry, and `SPEC_NAME` is `harness/v1`.

  Users of the old session presets move to `@agentproto/session-presets`; users of `@agentproto/driver-agent-cli` move to `@agentproto/harness` (same API, `defineHarness` added). `@agentproto/driver-agent-cli` stays published as a deprecated shim that re-exports the harness package unchanged, so existing installs keep working.

  The switched dependents only rename their dependency and import specifiers, hence the patch bumps.

- 76003b9: Declare native hook capabilities under `capabilities.hooks`, report them from harness capability discovery, and echo a session harness's declared hooks from `session_capabilities`.

### Patch Changes

- 52f8616: Accept the canonical AIP-70 document tags (for example `skill/v1` and `design/v1`) alongside their legacy aliases in every document parser. Writers keep emitting the legacy value until the next major.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- Updated dependencies [7a90c4b]
- Updated dependencies [8d8c10c]
- Updated dependencies [84ac51b]
  - @agentproto/harness@2.16.0
