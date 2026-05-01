# @agentproto/agencies-mastra

Mastra adapter for [agentagencies/v1](https://agentproto.sh/docs/agp-1).

## Two surfaces

### 1. Codegen (`./codegen`)

Turns a `PROCEDURE.md` (vendor-neutral playbook) into a Mastra `workflow.ts`.
Apps run this codegen once per procedure + commit the generated file.

```ts
import { procedureToWorkflow } from "@agentproto/agencies-mastra/codegen"

const procedure = await loadProcedure("design-project-execute")
const tsSource = procedureToWorkflow(procedure.frontmatter, {
  toolsModuleSpecifier: "@my-app/tools",
})

await writeFile(
  "apps/my-app/src/mastra/workflows/design-project-execute.ts",
  tsSource
)
```

### 2. Runtime (`./` main)

`createAgenciesBindings(config)` returns a bag of orchestration helpers:
engagement state machine, agreement issuer, invoice issuer. Phase 1 ships the
scaffold; Phase 2 wires actual Mastra suspend/resume.

## Status

**Alpha — scaffolding.** The codegen emits a skeleton with TODOs; full state
machine wiring lands in Phase 2 once the host workflow patterns stabilize.

## License

MIT
