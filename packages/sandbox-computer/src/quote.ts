/** shQuote a value so a `bash -lc <script>` can interpolate it safely. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
