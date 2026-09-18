import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  BRANDS,
  GLYPHS,
  MARKS,
  VENDORED,
  buildIcons,
  glyphColorFor,
  iconFor
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

  it('uses the official brand colour as the tile fill', () => {
    for (const [id, slug] of Object.entries(BRANDS)) {
      const svg = readFileSync(join(root, 'icons', `${id}.svg`), 'utf8')
      expect(svg).toContain(`fill="#${iconFor(slug).hex}"`)
    }
  })

  it('picks a glyph colour that stays legible on the brand tile', () => {
    // The two ends of the range: near-black brands need a white mark, bright
    // ones need a dark mark. A single fixed colour would fail one of them.
    expect(glyphColorFor('#000000')).toBe('#FFFFFF')
    expect(glyphColorFor('#181717')).toBe('#FFFFFF') // GitHub
    expect(glyphColorFor('#FFD21E')).toBe('#0B0B0C') // Hugging Face
    expect(glyphColorFor('#6AFDEF')).toBe('#0B0B0C') // Intercom
  })

  it('leaves non-brand art themable instead of baking a background', () => {
    // A first-party glyph sits on PackageIcon's own `bg-surface`, which follows
    // the light/dark theme. Baking a tile here would freeze it to one theme.
    for (const id of [...Object.keys(GLYPHS), ...Object.keys(MARKS)]) {
      const svg = readFileSync(join(root, 'icons', `${id}.svg`), 'utf8')
      expect(svg, `${id} must not bake a tile`).not.toContain('<rect')
      expect(svg).toContain('fill="#A3A3A3"')
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
})
