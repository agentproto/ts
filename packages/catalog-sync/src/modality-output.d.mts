/**
 * Types for `modality-output.mjs` - shared by `run-all.mjs` and its test.
 */

export type SyncModality = "llm" | "image" | "video" | "audio" | "voice"

export const SCRIPT_MODALITIES: Record<string, SyncModality>

export function modalityOf(script: string): SyncModality

export function vendorOf(script: string): string

export function outputPathOf(script: string, modelCatalogSrcDir: string): string

export function changelogHeading(modality: string, vendor: string): string
