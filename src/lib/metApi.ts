import { getSeenIds, markSeen } from './storage'

export type Artwork = {
  objectID: number
  title: string
  artist: string
  date: string
  imageUrl: string
  objectURL: string
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
}

const MET_BASE =
  import.meta.env.DEV
    ? '/met-api/public/collection/v1'
    : 'https://collectionapi.metmuseum.org/public/collection/v1'

let cachedObjectIds: number[] | null = null

async function searchPaintingIds(): Promise<number[]> {
  if (cachedObjectIds?.length) return cachedObjectIds

  const queries = [
    new URLSearchParams({
      q: 'painting',
      medium: 'Paintings',
      hasImages: 'true',
      isPublicDomain: 'true',
    }),
    new URLSearchParams({
      q: 'oil',
      medium: 'Paintings',
      hasImages: 'true',
      isPublicDomain: 'true',
    }),
    new URLSearchParams({
      q: 'portrait',
      hasImages: 'true',
      isPublicDomain: 'true',
      departmentId: '11',
    }),
  ]

  const idSet = new Set<number>()
  for (const params of queries) {
    try {
      const res = await fetch(`${MET_BASE}/search?${params}`)
      if (!res.ok) continue
      const data = (await res.json()) as { objectIDs?: number[] | null }
      for (const id of data.objectIDs ?? []) idSet.add(id)
    } catch {
      // try next query
    }
  }

  const ids = [...idSet]
  if (!ids.length) throw new Error('No Met paintings found')

  cachedObjectIds = ids
  return ids
}

async function fetchObject(id: number): Promise<MetObject> {
  const res = await fetch(`${MET_BASE}/objects/${id}`)
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
  }
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    img.src = url
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
