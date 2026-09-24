import { useEffect, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui/cn'
import { useDocumentTheme } from '@renderer/lib/ui/useDocumentTheme'
import type { ProviderId } from '@shared/ipc'
import {
  getCachedProviderBrand,
  loadProviderBrand,
  resolveProviderBrandSlug,
  type ProviderBrandData,
  type ProviderBrandSlug
} from './providerBrandPaths'
import { resolveProviderBrandColor } from './providerBrandColor'

export type ProviderLogoId = ProviderId | string

const SIZE = { xs: 12, sm: 16, md: 20, lg: 24 } as const

type LogoTone = 'brand' | 'current'

function BrandMark({
  slug,
  size,
  tone,
  className
}: {
  slug: ProviderBrandSlug
  size: number
  tone: LogoTone
  className?: string
}) {
  const theme = useDocumentTheme()
  const [brand, setBrand] = useState<ProviderBrandData | null>(
    () => getCachedProviderBrand(slug) ?? null
  )

  useEffect(() => {
    const cached = getCachedProviderBrand(slug)
    if (cached) {
      setBrand(cached)
      return
    }
    setBrand(null)
    let cancelled = false
    loadProviderBrand(slug)
      .then((data) => {
        if (!cancelled) setBrand(data)
      })
      .catch(() => {
        if (!cancelled) setBrand(null)
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  if (!brand) {
    // Letter tile while loading or on failure — never a blank gap.
    return <GenericIcon size={size} tone={tone} className={className} letter={slug.slice(0, 1)} />
  }

  const color = resolveProviderBrandColor(brand.colorPrimary, theme)
  return (
    <brand.Component
      size={size}
      style={tone === 'brand' ? { color } : undefined}
      className={cn('shrink-0', className)}
      aria-hidden="true"
    />
  )
}

function GenericIcon({
  size,
  tone,
  className,
  letter
}: {
  size: number
  tone: LogoTone
  className?: string
  letter: string
}) {
  const initial = letter.slice(0, 1).toUpperCase()
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-sm font-semibold',
        // A provider with no mark of its own: its initial on the surface, in every skin.
        tone === 'brand' ? 'bg-surface-2 text-secondary' : '',
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size - 6)
      }}
      aria-hidden
    >
      {initial}
    </span>
  )
}

export function ProviderLogo({
  id,
  subProvider,
  size = 'md',
  tone = 'brand',
  className
}: {
  id: ProviderLogoId
  subProvider?: string
  /** A named size, or pixels for a mark set in a tile of its own. */
  size?: keyof typeof SIZE | number
  /**
   * `brand` draws the mark in the vendor's colour; `current` takes the text
   * colour around it, for a list of marks that should read as one set.
   */
  tone?: LogoTone
  className?: string
}) {
  const px = typeof size === 'number' ? size : SIZE[size]
  const subSlug = subProvider ? resolveProviderBrandSlug(subProvider) : undefined
  const providerSlug = resolveProviderBrandSlug(String(id))
  const slug = subSlug ?? providerSlug

  if (!subProvider && id === 'custom') {
    return (
      <Icon name="mcp" size={px} className={cn('shrink-0', tone === 'brand' ? 'text-secondary' : '', className)} />
    )
  }

  if (slug) {
    return <BrandMark slug={slug} size={px} tone={tone} className={className} />
  }

  const fallbackKey = (subProvider ?? String(id)).toLowerCase()
  return <GenericIcon size={px} tone={tone} className={className} letter={fallbackKey.slice(0, 1)} />
}
