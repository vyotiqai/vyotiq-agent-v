/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { BrandTile } from '@renderer/features/marketplace/BrandTile'

afterEach(() => {
  cleanup()
})

/** `<svg/>`, enough to pass the data-URL allowlist. */
const SVG = 'data:image/svg+xml;base64,PHN2Zy8+'

describe('BrandTile', () => {
  it('sizes one-ink kit art so its ink, not its canvas, is half the tile', () => {
    // The kit puts 40 units of ink on a 64-unit canvas: 16px of ink needs a 26px canvas.
    const { container, rerender } = render(<BrandTile name="GitHub" iconUrl={SVG} iconMono size={32} />)
    let mask = container.querySelector<HTMLElement>('[data-brand-mask]')!
    expect([mask.style.width, mask.style.height]).toEqual(['26px', '26px'])
    expect(mask.style.maskImage).toContain(SVG)

    rerender(<BrandTile name="GitHub" iconUrl={SVG} iconMono size={44} />)
    mask = container.querySelector<HTMLElement>('[data-brand-mask]')!
    expect(mask.style.width).toBe('35px')
  })

  it('shows coloured art as it is, at half the tile', () => {
    const { container } = render(<BrandTile name="Playwright" iconUrl={SVG} iconMono={false} size={32} />)
    expect(container.querySelector('[data-brand-mask]')).toBeNull()
    const img = container.querySelector('img')!
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['16', '16'])
  })

  it('falls back to a monogram when the art is not an allowed data URL', () => {
    const { container } = render(<BrandTile name="remote" iconUrl="https://example.com/icon.svg" size={32} />)
    expect(container.querySelector('img, [data-brand-mask]')).toBeNull()
    expect(container.textContent).toBe('R')
  })
})
