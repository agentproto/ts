# @agentproto/rendezvous

## 0.2.0

### Minor Changes

- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- 6db7c6a: Add /healthz route, RENDEZVOUS\_\* env config surface, Dockerfile, and deploy docs

### Patch Changes

- 20add88: docs(rendezvous): complete env surface and correct RENDEZVOUS_DEBUG description
- e44242d: Fix Dockerfile: strip workspace:\* devDeps before npm install
- 234b2e6: Use numeric UID 1001 in Dockerfile so image starts under runAsNonRoot
