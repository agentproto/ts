/**
 * Shared in-terminal QR rendering — extracted from `pair.ts`'s `printQr` so
 * `agentproto remote enable --qr` (phoneUrl) can reuse the exact same
 * best-effort behaviour instead of a second copy.
 */

/** Render `url` as an in-terminal QR (best-effort — prints nothing extra if
 *  the `qrcode-terminal` dep isn't available). */
export async function printQr(url: string): Promise<void> {
  try {
    const mod = await import("qrcode-terminal")
    const qr = mod.default ?? mod
    await new Promise<void>(resolve => {
      qr.generate(url, { small: true }, (out: string) => {
        process.stdout.write(out + "\n")
        resolve()
      })
    })
  } catch {
    // qrcode-terminal not installed — the URL above is enough.
  }
}
