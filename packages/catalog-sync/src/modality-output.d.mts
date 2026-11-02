/**
 * Types for `modality-output.mjs` - shared by `run-all.mjs` and its test.
 */

export type SyncModality = "llm" | "image" | "video" | "audio" | "voice"

export const SCRIPT_MODALITIES: Record<string, SyncModality[]>

export function modalitiesOf(script: string): SyncModality[]

export function vendorOf(script: string): string

export function outputsOf(
  script: string,
  modelCatalogSrcDir: string
): Array<{ modality: SyncModality; path: string }>

export function diffIds(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>
): { added: string[]; removed: string[] }

export function changelogHeading(modality: string, vendor: string): string
