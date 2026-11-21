# @agentproto/usage-presets

## 0.1.1

### Patch Changes

- 4b56ce9: Replace the retired opencode/glm-5.3-flash-free with opencode-go/glm-5.3-flash in the usage presets and the default rotation.

  Behaviour note: the `explore` and `implement` presets now resolve to the free deepseek model (local, with sandbox overflow); the glm 5.3 flash model on the Go subscription (not free, no per-IP limit) serves `pr-fix` and `review` in the sandbox. No preset spends more than before except where the retired free glm sat.

## 0.1.0

### Minor Changes

- 3a7286f: feat(usage-presets): usage-named spawn presets (pr-fix/explore/implement/review/deploy)

  The caller names the WORK; the preset fixes the model, auth profile, posture, execution place (local vs OVH sandbox) and never which model to use / which place to use. Enforces the sensitive never-free rule + the 2-free-agents-local cap with sandbox redirect, and wires the new agentproto usage plan entrypoint into @agentproto/cli.
