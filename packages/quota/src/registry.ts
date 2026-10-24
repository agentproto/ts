import type { QuotaProfile, QuotaReadContext, QuotaReader, QuotaStatus } from "./types.js"

/** Identity helper that fixes the QuotaReader contract at definition time (AIP-43 handle). */
export function defineQuotaReader(reader: QuotaReader): QuotaReader {
  return reader
}

export class QuotaReaderRegistry {
  private readonly readers = new Map<string, QuotaReader>()

  register(reader: QuotaReader): this {
    if (this.readers.has(reader.id)) {
      throw new Error(`quota reader already registered: ${reader.id}`)
    }
    this.readers.set(reader.id, reader)
    return this
  }

  list(): QuotaReader[] {
    return [...this.readers.values()]
  }

  /** First registered reader that supports the profile, in registration order. */
  find(profile: QuotaProfile): QuotaReader | undefined {
    for (const reader of this.readers.values()) {
      if (safeSupports(reader, profile)) return reader
    }
    return undefined
  }

  /** Read through the first supporting reader. Never throws; unknown -> undefined. */
  async read(profile: QuotaProfile, ctx: QuotaReadContext = {}): Promise<QuotaStatus | undefined> {
    const reader = this.find(profile)
    if (!reader) return undefined
    try {
      return await reader.read(profile, ctx)
    } catch {
      return undefined
    }
  }
}

function safeSupports(reader: QuotaReader, profile: QuotaProfile): boolean {
  try {
    return reader.supports(profile)
  } catch {
    return false
  }
}
