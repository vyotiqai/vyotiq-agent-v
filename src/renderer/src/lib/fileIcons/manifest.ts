import { generateManifest, type Manifest } from 'material-icon-theme'

let cached: Manifest | null = null

/** Material Icon Theme manifest with the React icon pack (tsx/jsx → React icons). */
export function getFileIconManifest(): Manifest {
  if (!cached) {
    cached = generateManifest({ activeIconPack: 'react' })
  }
  return cached
}
