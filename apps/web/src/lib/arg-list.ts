/**
 * Splits a free-form launch-argument line into the argv tokens Waku appends
 * to a provider's binary.
 *
 * Mirrors `parse_arg_list` in `waku-protocol` so the desktop and web clients
 * store byte-identical `provider_extra_args` values. Tokens are separated by
 * runs of whitespace; a token wrapped in double quotes keeps its inner spaces
 * (`--config "my dir"`). Quotes are not shell quoting: no escaping, no
 * expansion, and an unmatched quote simply delimits nothing.
 */
export function parseArgList(text: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuotes = false
  let hasToken = false
  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch.trim() === '' && !inQuotes) {
      if (hasToken || current.length > 0) {
        args.push(current)
        current = ''
        hasToken = false
      }
    } else {
      current += ch
      hasToken = true
    }
  }
  if (hasToken || current.length > 0) {
    args.push(current)
  }
  return args
}

/**
 * Normalizes a provider's custom launch arguments into the stable string the
 * probe cache and query keys use. JSON encoding keeps distinct argv lists
 * apart even when their space-joined forms collide.
 */
export function normalizeProviderArgs(args?: string[] | null): string {
  return JSON.stringify(args ?? [])
}
