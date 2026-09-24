import { useEffect, useState } from 'react'
import { PlugsConnectedIcon } from '@phosphor-icons/react'
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

function BrandMark({
  slug,
  size,
  className
}: {
  slug: ProviderBrandSlug
  size: number
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
    return <GenericIcon size={size} className={className} letter={slug.slice(0, 1)} />
  }

  const color = resolveProviderBrandColor(brand.colorPrimary, theme)
  return (
    <brand.Component
      size={size}
      style={{ color }}
      className={cn('shrink-0', className)}
      aria-hidden="true"
    />
  )
}

function GenericIcon({
  size,
  className,
  letter
}: {
  size: number
  className?: string
  letter: string
}) {
  const initial = letter.slice(0, 1).toUpperCase()
  const hue = [...initial].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-sm font-semibold',
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size - 6),
        backgroundColor: `hsl(${hue} 70% 50% / 0.15)`,
        color: `hsl(${hue} 70% 55%)`
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
  className
}: {
  id: ProviderLogoId
  subProvider?: string
  size?: keyof typeof SIZE
  className?: string
}) {
  const px = SIZE[size]
  const subSlug = subProvider ? resolveProviderBrandSlug(subProvider) : undefined
  const providerSlug = resolveProviderBrandSlug(String(id))
  const slug = subSlug ?? providerSlug

  if (!subProvider && id === 'custom') {
    return (
      <PlugsConnectedIcon
        size={px}
        className={cn('shrink-0 text-secondary', className)}
        aria-hidden="true"
      />
    )
  }

  if (slug) {
    return <BrandMark slug={slug} size={px} className={className} />
  }

  const fallbackKey = (subProvider ?? String(id)).toLowerCase()
  return <GenericIcon size={px} className={className} letter={fallbackKey.slice(0, 1)} />
}
