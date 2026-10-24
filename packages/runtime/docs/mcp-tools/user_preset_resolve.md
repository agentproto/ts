# user_preset_resolve

Resolve a saved session preset (`~/.agentproto/presets.json`) into the config
a spawn would actually use, and report the layer that produced every axis.
Read-only. The spawn path calls the same pure resolver, so this is the
inspection view of precedence, not a second implementation.

## id

The saved session preset id to resolve (`agentproto preset list`).

## harness

Harness slug to resolve for. Defaults to the preset's own `harness` /
`adapter`. The harness selects the `defaultFor` session preset and the legacy
`harness-presets.json` default that sit below the named preset.

## Layers

Lowest to highest: `manifest`, `host`, `definition`, `harness-preset`,
`preset-default:<id>` (the harness's `defaultFor` preset), `preset:<id>`
(the named preset after its `extends` chain), `request`.

Each axis is replaced whole by the highest layer that sets it, except
`options` (merged key by key), `tags` (unioned) and `modelPolicy` (both
policies apply).

## Output

`{ preset, config, layers }`. `config` holds the resolved axes; `layers` maps
each axis to the layer string above.

Example:

```json
{
  "preset": "example-preset",
  "config": { "model": "vendor/model", "effort": "high" },
  "layers": { "model": "preset:example-preset", "effort": "request" }
}
```
