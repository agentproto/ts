/**
 * The `realtime` engine of AIP-VOICE: a thin delegation to a `RealtimeProvider`.
 * Turn detection and interruption happen at the vendor; the session only
 * reports them. The kit adds one guarantee on top of the provider's session:
 * `getUsage()` stays readable and final after `close()`.
 */
import type {
  RealtimeProvider,
  VoiceSession,
  VoiceStartOptions,
  VoiceUsage,
} from "./types.js"

export async function startRealtime(
  provider: RealtimeProvider,
  opts: VoiceStartOptions,
): Promise<VoiceSession> {
  const session = await provider.start(opts)
  if (session.engine !== "realtime") {
    throw new Error(
      `realtime provider "${provider.slug}" returned a "${session.engine}" session`,
    )
  }
  let finalUsage: VoiceUsage | undefined
  return {
    ...session,
    pushAudio: frame => session.pushAudio(frame),
    commit: () => session.commit(),
    interrupt: () => session.interrupt(),
    ...(session.pushText ? { pushText: (t: string) => session.pushText!(t) } : {}),
    ...(session.refreshTools ? { refreshTools: () => session.refreshTools!() } : {}),
    ...(session.say ? { say: (d: string) => session.say!(d) } : {}),
    getUsage: () => finalUsage ?? session.getUsage?.(),
    async close() {
      try {
        finalUsage = session.getUsage?.()
      } catch {
        // usage is best effort at close
      }
      await session.close()
      finalUsage = session.getUsage?.() ?? finalUsage
    },
  }
}
