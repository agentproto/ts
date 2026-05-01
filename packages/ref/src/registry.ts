import type { AnyRef, KindDefinition } from "./types.js"

const KIND_NAME_RE = /^[a-z][a-z0-9_]*$/

const registry = new Map<string, KindDefinition<AnyRef>>()

export function registerRefKind<V extends { kind: string }>(
  definition: KindDefinition<V>
): void {
  if (!KIND_NAME_RE.test(definition.kind)) {
    throw new Error(
      `Invalid kind name '${definition.kind}': must match ${KIND_NAME_RE}`
    )
  }
  registry.set(definition.kind, definition as unknown as KindDefinition<AnyRef>)
}

export function getRefKind(kind: string): KindDefinition<AnyRef> | undefined {
  return registry.get(kind)
}

export function listRefKinds(): string[] {
  return [...registry.keys()].sort()
}

export function listKindsByCollection(collection: string): string[] {
  return [...registry.entries()]
    .filter(([, def]) => def.collections.includes(collection))
    .map(([kind]) => kind)
    .sort()
}

export function listCollections(): string[] {
  const collections = new Set<string>()
  for (const def of registry.values()) {
    for (const c of def.collections) collections.add(c)
  }
  return [...collections].sort()
}

export function refMatchesCollection(ref: AnyRef, collection: string): boolean {
  const def = registry.get(ref.kind)
  return !!def && def.collections.includes(collection)
}

export function clearRegistry(): void {
  registry.clear()
}
