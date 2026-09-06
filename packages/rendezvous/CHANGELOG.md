# @agentproto/rendezvous

## 0.2.2

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.2.1

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.

## 0.2.0

### Minor Changes

- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- 6db7c6a: Add /healthz route, RENDEZVOUS\_\* env config surface, Dockerfile, and deploy docs

### Patch Changes

- 20add88: docs(rendezvous): complete env surface and correct RENDEZVOUS_DEBUG description
- e44242d: Fix Dockerfile: strip workspace:\* devDeps before npm install
- 234b2e6: Use numeric UID 1001 in Dockerfile so image starts under runAsNonRoot
