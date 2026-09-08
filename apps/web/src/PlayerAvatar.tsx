import { useState } from 'react'

const CDN = 'https://cdn-mister.mundodeportivo.com/file/cdn-common/players'

/**
 * La foto la sirve el CDN de Mister indexada por el mismo id de jugador que ya
 * extrae el scraper de `data-id_player`, asi que no hay que guardar ni una URL:
 * se compone. Los canteranos recien subidos no tienen imagen y el CDN devuelve
 * un 404 limpio, de modo que se cae a las iniciales antes que dejar el hueco.
 *
 * El alt va vacio a proposito: el nombre del jugador esta siempre al lado, y
 * repetirlo solo haria que un lector de pantalla lo dijera dos veces.
 */
export function PlayerAvatar({
  id,
  name,
  size = 'md',
}: {
  id: number
  name: string
  size?: 'sm' | 'md'
}) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    const initials = name
      .split(/[\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w.charAt(0))
      .join('')
      .toUpperCase()
    return (
      <div className={`avatar avatar--${size} avatar--empty`} aria-hidden="true">
        {initials}
      </div>
    )
  }

  return (
    <img
      className={`avatar avatar--${size}`}
      src={`${CDN}/${id}.png`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
