export interface PluginDefinition {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
  name: string
  version?: string
  description?: string
  author?: string | { name: string; url?: string }
  homepage?: string
  repository?: string | { type: string; url: string }
  license?: string
  keywords?: string[]
  extensions?: Record<string, { path: string; description?: string }>
}

export interface PluginHandle extends Readonly<PluginDefinition> {
  readonly skills: readonly string[]
  readonly hasMcp: boolean
  readonly extensionDirs: readonly string[]
}
