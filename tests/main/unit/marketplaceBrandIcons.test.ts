import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  BRANDS,
  GLYPHS,
  MARKS,
  VENDORED,
  buildIcons
} from '../../../scripts/sync-marketplace-brand-icons.mjs'
import { isAllowedMarketplaceIconUrl } from '@shared/utils/marketplaceIconUrl'

const root = join(__dirname, '../../../resources/marketplace')
const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')) as {
  packages: { id: string; name: string; iconPath?: string }[]
}
const byId = new Map(catalog.packages.map((p) => [p.id, p]))
const generatedIds = [...Object.keys(BRANDS), ...Object.keys(MARKS), ...Object.keys(GLYPHS)]

describe('marketplace icons', () => {
  it('ships a file for every generated id and links it in the catalog', () => {
    for (const id of generatedIds) {
      const entry = byId.get(id)
      expect(entry, `catalog entry ${id}`).toBeTruthy()
      expect(entry!.iconPath, `iconPath for ${id}`).toBe(`icons/${id}.svg`)
      expect(existsSync(join(root, 'icons', `${id}.svg`)), `file for ${id}`).toBe(true)
    }
  })

  it('matches what the generator produces, so committed art cannot drift', async () => {
    // Catches a catalog edit, or a simple-icons/phosphor bump, never re-synced.
    for (const [id, svg] of await buildIcons()) {
      const onDisk = readFileSync(join(root, 'icons', `${id}.svg`), 'utf8')
      expect(onDisk, `${id}.svg is stale — run pnpm sync:marketplace-icons`).toBe(svg)
    }
  })

  it('paints every generated icon in one ink and nothing else', () => {
    // The identity is black and white, so a vendor's own hex is not ours to
    // paint with. One ink also means a consumer can invert the whole set for
    // its dark theme without knowing which source any icon came from.
    for (const id of generatedIds) {
      const svg = readFileSync(join(root, 'icons', `${id}.svg`), 'utf8')
      const colours = new Set(svg.match(/#[0-9A-Fa-f]{3,6}/g) ?? [])
      expect([...colours], `${id} may only use the ink`).toEqual(['#000000'])
    }
  })

  it('bakes no background, so the surface behind it stays theme-owned', () => {
    // An icon sits on PackageIcon's own `bg-surface`, which follows the
    // light/dark theme. Baking a tile here would freeze it to one of them —
    // and a tile is also a second colour, which the ink rule above forbids.
    for (const id of generatedIds) {
      const svg = readFileSync(join(root, 'icons', `${id}.svg`), 'utf8')
      expect(svg, `${id} must not bake a tile`).not.toContain('<rect')
    }
  })

  it('keeps the hand-drawn icons to the same ink, at two opacities', () => {
    // These are not generated: they are committed line art with a silhouette
    // and a lighter interior detail. The hierarchy survives as one black at
    // two opacities rather than as two greys, so inverting still works.
    const handDrawn = readdirSync(join(root, 'icons')).filter(
      (f) => f.endsWith('.svg') && !generatedIds.includes(f.replace('.svg', ''))
    )
    for (const file of handDrawn) {
      if (Object.values(VENDORED).some((v) => v.file === file)) continue
      const svg = readFileSync(join(root, 'icons', file), 'utf8')
      const colours = new Set(svg.match(/#[0-9A-Fa-f]{3,6}/g) ?? [])
      expect([...colours], `${file} may only use the ink`).toEqual(['#000000'])
    }
  })

  it('produces markup the renderer will actually accept as an icon', () => {
    for (const id of generatedIds) {
      const svg = readFileSync(join(root, 'icons', `${id}.svg`), 'utf8')
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
      expect(svg).not.toContain('<script')
      // Same shape `enrichCatalogEntryIcons` builds before it reaches the CSP.
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
      expect(isAllowedMarketplaceIconUrl(dataUrl), `data url for ${id}`).toBe(true)
    }
  })

  it('keeps the vendored marks present, linked and renderable', () => {
    // No package ships these, so the sync script cannot rebuild them — it only
    // checks they exist. If one is deleted, re-fetch it from VENDORED[id].source.
    for (const [id, { file }] of Object.entries(VENDORED)) {
      const abs = join(root, 'icons', file)
      expect(existsSync(abs), `${file} missing — re-download from ${VENDORED[id].source}`).toBe(
        true
      )
      expect(byId.get(id)?.iconPath, `iconPath for ${id}`).toBe(`icons/${file}`)

      const bytes = readFileSync(abs)
      if (file.endsWith('.svg')) {
        const svg = bytes.toString('utf8')
        // Third-party markup, so assert it carries nothing active.
        expect(svg).not.toMatch(/<script|onload=|onerror=|<foreignObject|javascript:/i)
        expect(isAllowedMarketplaceIconUrl(`data:image/svg+xml;base64,${bytes.toString('base64')}`))
          .toBe(true)
      } else {
        expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a') // PNG magic
        expect(isAllowedMarketplaceIconUrl(`data:image/png;base64,${bytes.toString('base64')}`))
          .toBe(true)
      }
    }
  })

  it('leaves no catalog entry without an icon', () => {
    const without = catalog.packages.filter((p) => !p.iconPath).map((p) => p.id)
    expect(without).toEqual([])
  })

  /**
   * Both directions, because neither fails loudly on its own: bake-app-data
   * nulls an icon whose file is missing, so a typo'd iconPath ships as a bare
   * letter tile, and a file nothing points at is dead weight in every build.
   */
  it('pairs every icon file with exactly one catalog entry', () => {
    const referenced = new Set(
      catalog.packages.flatMap((p) => (p.iconPath ? [p.iconPath.replace(/^icons\//, '')] : []))
    )
    const onDisk = new Set(readdirSync(join(root, 'icons')))

    expect([...referenced].filter((file) => !onDisk.has(file))).toEqual([])
    expect([...onDisk].filter((file) => !referenced.has(file))).toEqual([])
  })
})
