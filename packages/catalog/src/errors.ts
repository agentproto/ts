export class CatalogSourceDuplicateError extends Error {
  readonly code = "catalog_source_duplicate" as const
  constructor(family: string, id: string) {
    super(
      `[catalog/${family}] source '${id}' is already registered. ` +
        `Call removeSource('${id}') first if replacement is intentional.`,
    )
    this.name = "CatalogSourceDuplicateError"
  }
}

export class CatalogSourceNotFoundError extends Error {
  readonly code = "catalog_source_not_found" as const
  constructor(family: string, id: string) {
    super(
      `[catalog/${family}] source '${id}' is not registered.`,
    )
    this.name = "CatalogSourceNotFoundError"
  }
}
