/**
 * Language-tag normalization — the single source of truth for coercing a
 * raw language value into the AIP-10 source shape `^[a-z]{2}(-[A-Z]{2})?$`.
 *
 * Two upstreams feed it, which is why this used to be two drifted copies:
 *   - **STT** (Whisper verbose_json) emits a full English NAME ("english",
 *     "french").
 *   - **readability / browser** fetchers read `<html lang>` VERBATIM, in any
 *     case and separator ("en-us", "EN", "pt_BR", "zh-Hant-TW").
 *
 * One function handles both: map a known name → code, else parse a BCP-47
 * tag — lowercase the 2-letter primary, uppercase a genuine 2-letter region,
 * and discard scripts / extensions / 3-letter primaries (which the AIP-10
 * source schema doesn't allow) rather than emit something that fails
 * validation. Returns `undefined` for anything unparseable so the field is
 * omitted, never written invalid.
 */

const NAME_TO_CODE: Readonly<Record<string, string>> = {
  english: "en", french: "fr", spanish: "es", german: "de", italian: "it",
  portuguese: "pt", dutch: "nl", russian: "ru", japanese: "ja", korean: "ko",
  chinese: "zh", arabic: "ar", hindi: "hi", turkish: "tr", polish: "pl",
  swedish: "sv", norwegian: "no", danish: "da", finnish: "fi", greek: "el",
  hebrew: "he", thai: "th", vietnamese: "vi", indonesian: "id", ukrainian: "uk",
}

export function normalizeLanguageTag(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const v = raw.trim().toLowerCase()
  if (!v) return undefined
  const named = NAME_TO_CODE[v]
  if (named) return named
  // BCP-47: subtags split on "-" or "_" (POSIX locales like pt_BR appear in
  // <html lang>). Require a 2-letter primary; append only a 2-letter region.
  const parts = v.split(/[-_]/)
  const primary = parts[0]
  if (!primary || !/^[a-z]{2}$/.test(primary)) return undefined
  const region = parts.slice(1).find(p => /^[a-z]{2}$/.test(p))
  return region ? `${primary}-${region.toUpperCase()}` : primary
}
