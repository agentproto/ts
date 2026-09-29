import { assertSpawnArgsSafe, type BrowserProfileRefusedError } from "@agentproto/driver-browser"

/**
 * Gate a Chrome launch against `userDataDir` before anything spawns. Delegates
 * to the kit's F11 refusal (`assertSpawnArgsSafe`); nothing is re-implemented
 * here. Throws {@link BrowserProfileRefusedError} (`browser:profile-refused`)
 * when `userDataDir` is, or sits inside, a default Chrome user-data-dir.
 *
 * The scanner in this package only READS cookies from a profile. A host that
 * launches Chrome per profile must pass its `--user-data-dir` through this first.
 */
export function assertChromeLaunchDirSafe(userDataDir: string, providerId: string): void {
  assertSpawnArgsSafe([`--user-data-dir=${userDataDir}`], providerId)
}

export type { BrowserProfileRefusedError }
