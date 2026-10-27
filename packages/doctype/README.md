# @agentproto/doctype

Meta-factory for AIP `defineX(definition)` constructors. `createDoctype` lifts
the invariants every define function shares (id shape, description length,
freezing, error prefix) into one place, so each AIP package only supplies its
spec-specific `validate` and `build` steps.

Spec: [AIP-56](https://agentproto.sh/docs/aip-56)

## Install

```sh
pnpm add @agentproto/doctype
```

## Usage

```ts
import { createDoctype } from "@agentproto/doctype"

interface WidgetDefinition {
  id: string
  description: string
  color: string
}

interface WidgetHandle extends Readonly<WidgetDefinition> {}

export const defineWidget = createDoctype<WidgetDefinition, WidgetHandle>({
  aip: 56,
  name: "widget",
  validate(definition) {
    if (!definition.color) throw new Error("widget needs a color")
  },
  build(definition) {
    return { ...definition }
  },
})
```

`@agentproto/define-doctype` is the deprecated old name; it remains a thin
re-export shim for existing installs.
