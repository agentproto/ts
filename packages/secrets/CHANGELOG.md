# @agentproto/secrets

## 0.2.0

### Minor Changes

- 6d4aa4b: Add E2E pairing: daemon identity, pair/v1 handshake, wrapE2E AEAD channel
- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- 8a4d5d5: Add opt-in E2E encryption for the serve --connect tunnel (tunnel-e2e/v1)
- 3639abd: Default pair offer to the hosted rendezvous broker when nothing is configured

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/auth@0.1.1
  - @agentproto/define-doctype@0.1.1

## 0.1.0

### Minor Changes

- fe13f4e: Add mcp-header SecretExposure variant and resolveMcpHeaderExposure
- e94757d: Add broker-resolved provision auth headers; export resolveProvisionHeaders and main

### Patch Changes

- 829a6c0: Document credential store, broker resolveHeaders, and mcp-header exposure
- Updated dependencies [c359894]
- Updated dependencies [829a6c0]
- Updated dependencies [547c796]
- Updated dependencies [83ce80f]
- Updated dependencies [c69d424]
- Updated dependencies [e94757d]
- Updated dependencies [d993560]
- Updated dependencies [9fe8586]
- Updated dependencies [da9f77a]
  - @agentproto/auth@0.1.0
