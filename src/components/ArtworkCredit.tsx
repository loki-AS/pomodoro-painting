import type { Artwork } from '../lib/metApi'
import './ArtworkCredit.css'

type Props = {
  artwork: Artwork | null
  visible: boolean
}

export function ArtworkCredit({ artwork, visible }: Props) {
  if (!artwork) return null

  return (
    <aside
      className={`artwork-credit ${visible ? 'artwork-credit--visible' : ''}`}
      aria-hidden={!visible}
    >
      <p className="artwork-credit__title">{artwork.title}</p>
      <p className="artwork-credit__meta">
        {artwork.artist}
        {artwork.date ? ` · ${artwork.date}` : ''}
      </p>
      <p className="artwork-credit__source">The Metropolitan Museum of Art</p>
    </aside>
  )
}
