/**
 * Two letters standing for a name, for the collapsed sidebar's badges:
 * "Office Anesthesia" -> "OA", "agent-fleet" -> "AF", "web" -> "WE".
 */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0] ?? name).slice(0, 2).toUpperCase()
}
