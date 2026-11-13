import { getSeenIds, markSeen } from './storage'

export type Artwork = {
  objectID: number
  title: string
  artist: string
  date: string
  imageUrl: string
  objectURL: string
  /** Extra catalogue details, used for the spoken narration */
  medium: string
  department: string
  culture: string
  period: string
  /** e.g. "Dutch, Zundert 1853–1890 Auvers-sur-Oise" */
  artistBio: string
  objectWikidataUrl: string
  artistWikidataUrl: string
}

type MetObject = {
  objectID: number
  title?: string
  artistDisplayName?: string
  objectDate?: string
  primaryImage?: string
  primaryImageSmall?: string
  isPublicDomain?: boolean
  objectURL?: string
  medium?: string
  department?: string
  culture?: string
  period?: string
  artistDisplayBio?: string
  objectWikidata_URL?: string
  artistWikidata_URL?: string
}

const MET_ORIGIN = import.meta.env.DEV
  ? '/met-api'
  : 'https://collectionapi.metmuseum.org'

const MET_SEARCH = `${MET_ORIGIN}/public/collection/v1.1/search`
const MET_OBJECTS = `${MET_ORIGIN}/public/collection/v1/objects`

let cachedObjectIds: number[] | null = null

async function searchPage(
  filter: Record<string, string>,
  offset: number,
  limit: number,
): Promise<{ total: number; ids: number[] }> {
  const params = new URLSearchParams({
    ...filter,
    limit: String(limit),
    offset: String(offset),
  })
  const res = await fetch(`${MET_SEARCH}?${params}`)
  if (!res.ok) throw new Error(`Met search failed: ${res.status}`)
  const data = (await res.json()) as {
    total?: number
    objectIDs?: number[] | null
    message?: string
  }
  if (data.message && !data.objectIDs) throw new Error(data.message)
  return { total: data.total ?? 0, ids: data.objectIDs ?? [] }
}

async function searchPaintingIds(): Promise<number[]> {
  if (cachedObjectIds?.length) return cachedObjectIds

  const filters: Record<string, string>[] = [
    { q: 'painting', medium: 'Paintings', hasImages: 'true', isPublicDomain: 'true' },
    { q: 'oil on canvas', medium: 'Paintings', hasImages: 'true', isPublicDomain: 'true' },
    { q: 'portrait', hasImages: 'true', isPublicDomain: 'true', departmentId: '11' },
  ]

  const idSet = new Set<number>()

  for (const filter of filters) {
    try {
      const first = await searchPage(filter, 0, 200)
      for (const id of first.ids) idSet.add(id)

      // One extra random page for variety (v1.1 caps offset+limit at 10000)
      const reachable = Math.min(first.total, 10000)
      if (reachable > 200) {
        const limit = 200
        const pages = Math.floor(reachable / limit)
        const pageIndex = 1 + Math.floor(Math.random() * Math.max(1, pages - 1))
        const more = await searchPage(filter, pageIndex * limit, limit)
        for (const id of more.ids) idSet.add(id)
      }
      if (idSet.size >= 150) break
    } catch {
      // try next filter
    }
  }

  const ids = [...idSet]
  if (!ids.length) throw new Error('No Met paintings found')

  cachedObjectIds = ids
  return ids
}

async function fetchObject(id: number): Promise<MetObject> {
  const res = await fetch(`${MET_OBJECTS}/${id}`)
  if (!res.ok) throw new Error(`Met object ${id} failed: ${res.status}`)
  return (await res.json()) as MetObject
}

function toArtwork(obj: MetObject): Artwork | null {
  const imageUrl = obj.primaryImage || obj.primaryImageSmall
  if (!imageUrl || !obj.isPublicDomain) return null

  return {
    objectID: obj.objectID,
    title: obj.title?.trim() || 'Untitled',
    artist: obj.artistDisplayName?.trim() || 'Unknown artist',
    date: obj.objectDate?.trim() || '',
    imageUrl,
    objectURL: obj.objectURL ?? '',
    medium: obj.medium?.trim() ?? '',
    department: obj.department?.trim() ?? '',
    culture: obj.culture?.trim() ?? '',
    period: obj.period?.trim() ?? '',
    artistBio: obj.artistDisplayBio?.trim() ?? '',
    objectWikidataUrl: obj.objectWikidata_URL?.trim() ?? '',
    artistWikidataUrl: obj.artistWikidata_URL?.trim() ?? '',
  }
}

function resolveImageUrl(url: string): string {
  if (import.meta.env.DEV && url.startsWith('https://images.metmuseum.org')) {
    return url.replace('https://images.metmuseum.org', '/met-images')
  }
  return url
}

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const resolved = resolveImageUrl(url)
  const res = await fetch(resolved)
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error(`Failed to load image: ${url}`))
    }
    img.src = objectUrl
  })
}

function pickRandomUnseen(ids: number[], seen: Set<number>): number | null {
  const available = ids.filter((id) => !seen.has(id))
  const pool = available.length ? available : ids
  if (!pool.length) return null
  return pool[Math.floor(Math.random() * pool.length)]!
}

export async function fetchRandomArtwork(maxAttempts = 12): Promise<Artwork> {
  const ids = await searchPaintingIds()
  const seen = new Set(getSeenIds())

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = pickRandomUnseen(ids, seen)
    if (id == null) break

    try {
      const obj = await fetchObject(id)
      const artwork = toArtwork(obj)
      if (!artwork) {
        seen.add(id)
        continue
      }
      await loadImage(artwork.imageUrl)
      markSeen(artwork.objectID)
      return artwork
    } catch {
      seen.add(id)
    }
  }

  throw new Error('Could not load a Met painting after several attempts')
}
