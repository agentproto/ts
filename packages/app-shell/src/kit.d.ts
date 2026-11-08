export interface KitOption {
  value: string
  label: string
}
export const KITS: KitOption[]
export function applyKit(value: string, storageKey: string): void
export function initialKit(search: string, storageKey: string): string
