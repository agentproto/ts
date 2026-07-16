# @agentproto/auth

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1

## 0.1.0

### Minor Changes

- c359894: Add pluggable CredentialStore (Keychain/Memory/File) and CredentialBroker.resolveHeaders
- 83ce80f: Add device-code RFC 8628 flow engine with daemon credential persistence
- c69d424: Add optional audience scoping to auth providers and CredentialBroker
- d993560: Add openBrowser opt-out to FlowRunOptions; dedupe legacyRef via resolveStoreRefs
- 9fe8586: Add refreshOnly mode + CeremonyRequiredError; honor --no-browser; silent serve refresh

### Patch Changes

- 829a6c0: Document credential store, broker resolveHeaders, and mcp-header exposure
- 547c796: Extract shared RFC 8628 device-grant poll primitive into internal flow-engines/device-grant.ts
- e94757d: Add broker-resolved provision auth headers; export resolveProvisionHeaders and main
- da9f77a: Add auth skill doc and include skill/ dir in package files
