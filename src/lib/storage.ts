const SEEN_KEY = 'atelier-seen-ids'
const MAX_SEEN = 500

export function getSeenIds(): number[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is number => typeof id === 'number')
  } catch {
    return []
  }
}

export function markSeen(id: number): void {
  const seen = getSeenIds()
  if (seen.includes(id)) return
  seen.push(id)
  const trimmed = seen.length > MAX_SEEN ? seen.slice(-MAX_SEEN) : seen
  localStorage.setItem(SEEN_KEY, JSON.stringify(trimmed))
}
