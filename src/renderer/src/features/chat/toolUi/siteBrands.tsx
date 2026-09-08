/**
 * Host -> brand icon for the web-search tool timeline.
 *
 * Brand modules are lazy-loaded from @lobehub/icons (same pattern as
 * composer/providerBrandPaths.ts: dynamic import of the Mono component plus its
 * style module for COLOR_PRIMARY). Never import the package barrel here — the
 * renderer bundle ships @lobehub/icons only through these per-brand chunks.
 *
 * Verified against node_modules/@lobehub/icons/es 5.18.0: Reddit, X/Twitter,
 * LinkedIn and DuckDuckGo do NOT exist in this package, so those hosts use
 * inline Simple Icons marks (CC0, fetched from unpkg simple-icons) below.
 */

import { useEffect, useState, type ComponentType, type CSSProperties } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { useDocumentTheme } from '@renderer/lib/ui/useDocumentTheme'
import { resolveProviderBrandColor } from '../components/composer/providerBrandColor'

export type SiteBrand = { key: string; label: string }

type BrandData = {
  Component: ComponentType<{
    size?: number | string
    style?: CSSProperties
    className?: string
  }>
  colorPrimary: string
}

type BrandModule = { default: BrandData['Component'] }
type BrandStyle = { COLOR_PRIMARY: string }

/** Brands that actually exist under @lobehub/icons/es (casing verified). */
const SITE_BRANDS: Array<SiteBrand & { module: string; hosts: readonly string[] }> = [
  { key: 'github', label: 'GitHub', module: 'Github', hosts: ['github.com'] },
  { key: 'figma', label: 'Figma', module: 'Figma', hosts: ['figma.com'] },
  {
    key: 'notion',
    label: 'Notion',
    module: 'Notion',
    hosts: ['notion.so', 'notion.site']
  }
]

/**
 * Social/brand marks missing from @lobehub/icons — inline Simple Icons paths
 * (CC0). `color` is the official brand color; SiteBrandIcon runs it through
 * resolveProviderBrandColor so it stays legible on both themes.
 */
const INLINE_BRANDS: Array<SiteBrand & { path: string; color: string; hosts: readonly string[] }> = [
  {
    key: 'reddit',
    label: 'Reddit',
    color: '#FF4500',
    hosts: ['reddit.com'],
    path: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z'
  },
  {
    key: 'x',
    label: 'X',
    color: '#000000',
    hosts: ['x.com', 'twitter.com'],
    path: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z'
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    color: '#0A66C2',
    hosts: ['linkedin.com'],
    path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z'
  },
  {
    key: 'duckduckgo',
    label: 'DuckDuckGo',
    color: '#DE5833',
    hosts: ['duckduckgo.com'],
    path: 'M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm0 .984C18.083.984 23.016 5.916 23.016 12S18.084 23.016 12 23.016.984 18.084.984 12C.984 5.917 5.916.984 12 .984zm0 .938C6.434 1.922 1.922 6.434 1.922 12c0 4.437 2.867 8.205 6.85 9.55-.237-.82-.776-2.753-1.6-6.052-1.184-4.741-2.064-8.606 2.379-9.813.047-.011.064-.064.03-.093-.514-.467-1.382-.548-2.233-.38a.06.06 0 0 1-.07-.058c0-.011 0-.023.011-.035.205-.286.572-.507.822-.64a1.843 1.843 0 0 0-.607-.335c-.059-.022-.059-.12-.006-.144.006-.006.012-.012.024-.012 1.749-.233 3.586.292 4.49 1.448.011.011.023.017.035.023 2.968.635 3.509 4.837 3.328 5.998a9.607 9.607 0 0 0 2.346-.576c.746-.286 1.008-.222 1.101-.053.1.193-.018.513-.28.81-.496.567-1.393 1.01-2.974 1.137-.546.044-1.029.024-1.445.006-.789-.035-1.339-.059-1.633.39-.192.298-.041.998 1.487 1.22 1.09.157 2.078.047 2.798-.034.643-.07 1.073-.118 1.172.069.21.402-.996 1.207-3.066 1.224-.158 0-.315-.006-.467-.011-1.283-.065-2.227-.414-2.816-.735a.094.094 0 0 1-.035-.017c-.105-.059-.31.045-.188.267.07.134.444.478 1.004.776-.058.466.087 1.184.338 2l.088-.016c.041-.009.087-.019.134-.025.507-.082.775.012.926.175.717-.536 1.913-1.294 2.03-1.154.583.694.66 2.332.53 2.99-.004.012-.017.024-.04.035-.274.117-1.783-.296-1.783-.511-.059-1.075-.26-1.173-.493-1.225h-.156c.006.006.012.018.018.03l.052.12c.093.257.24 1.063.13 1.26-.112.199-.835.297-1.284.303-.443.006-.543-.158-.637-.408-.07-.204-.103-.675-.103-.95a.857.857 0 0 1 .012-.216c-.134.058-.333.193-.397.281-.017.262-.017.682.123 1.149.07.221-1.518 1.164-1.74.99-.227-.181-.634-1.952-.459-2.67-.187.017-.338.075-.42.191-.367.508.093 2.933.582 3.248.257.169 1.54-.553 2.176-1.095.105.145.305.158.553.158.326-.012.782-.06 1.103-.158.192.45.423.972.613 1.388 4.47-1.032 7.803-5.037 7.803-9.82 0-5.566-4.512-10.078-10.078-10.078zm1.791 5.646c-.42 0-.678.146-.795.332-.023.047.047.094.094.07.14-.075.357-.161.701-.156.328.006.516.09.67.159l.023.01c.041.017.088-.03.059-.065-.134-.18-.332-.35-.752-.35zm-5.078.198a1.24 1.24 0 0 0-.522.082c-.454.169-.67.526-.67.76 0 .051.112.057.141.011.081-.123.21-.31.617-.478.408-.17.73-.146.951-.094.047.012.083-.041.041-.07a.989.989 0 0 0-.558-.211zm5.434 1.423a.651.651 0 0 0-.655.647.652.652 0 0 0 1.307 0 .646.646 0 0 0-.652-.647zm.283.262h.008a.17.17 0 0 1 .17.17c0 .093-.077.17-.17.17a.17.17 0 0 1-.17-.17c0-.09.072-.165.162-.17zm-5.358.076a.752.752 0 0 0-.758.758c0 .42.338.758.758.758s.758-.337.758-.758a.756.756 0 0 0-.758-.758zm.328.303h.01c.112 0 .2.089.2.2 0 .11-.088.197-.2.197a.195.195 0 0 1-.197-.198c0-.107.082-.194.187-.199z'
  }
]

function matchHostSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

const SITE_BRAND_LOADERS: Record<string, () => Promise<BrandData>> = Object.fromEntries(
  SITE_BRANDS.map((brand) => [
    brand.key,
    async (): Promise<BrandData> => {
      const [mod, st] = await Promise.all([
        import(`@lobehub/icons/es/${brand.module}/components/Mono`) as Promise<BrandModule>,
        import(`@lobehub/icons/es/${brand.module}/style`) as Promise<BrandStyle>
      ])
      return { Component: mod.default, colorPrimary: st.COLOR_PRIMARY }
    }
  ])
)

const brandCache = new Map<string, BrandData>()
const brandInflight = new Map<string, Promise<BrandData>>()

function loadSiteBrand(key: string): Promise<BrandData> | undefined {
  const hit = brandCache.get(key)
  if (hit) return Promise.resolve(hit)
  const loader = SITE_BRAND_LOADERS[key]
  if (!loader) return undefined
  let pending = brandInflight.get(key)
  if (!pending) {
    pending = loader().then((data) => {
      brandCache.set(key, data)
      brandInflight.delete(key)
      return data
    })
    brandInflight.set(key, pending)
  }
  return pending
}

function getCachedSiteBrand(key: string): BrandData | undefined {
  return brandCache.get(key)
}

/** Hosts that resolve to a brand mark (inline marks first, then lazy modules). */
export function siteBrandForHost(host: string | undefined): SiteBrand | undefined {
  const normalized = normalizeHost(host)
  if (!normalized) return undefined
  const inline = INLINE_BRANDS.find((entry) =>
    entry.hosts.some((suffix) => matchHostSuffix(normalized, suffix))
  )
  if (inline) return { key: inline.key, label: inline.label }
  const brand = SITE_BRANDS.find((entry) =>
    entry.hosts.some((suffix) => matchHostSuffix(normalized, suffix))
  )
  return brand ? { key: brand.key, label: brand.label } : undefined
}

const SEARCH_ENGINE_HOSTS = ['google.com', 'bing.com', 'duckduckgo.com'] as const

/** Generic engines keep the in-app search glyph instead of a brand mark. */
export function isSearchEngineHost(host: string | undefined): boolean {
  const normalized = normalizeHost(host)
  if (!normalized) return false
  return SEARCH_ENGINE_HOSTS.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`)
  )
}

function normalizeHost(host: string | undefined): string {
  const raw = (host ?? '').trim().toLowerCase()
  if (!raw) return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
  } catch {
    return raw.split('/')[0] ?? raw
  }
}

/** Hostname (or shortened URL) a favicon / read label can key on. */
export function hostForUrl(url: string | undefined): string {
  const normalized = normalizeHost(url)
  return normalized || (url ?? '').trim()
}

export function SiteBrandIcon({
  host,
  size = 14,
  className
}: {
  host: string | undefined
  size?: number
  className?: string
}) {
  const theme = useDocumentTheme()
  const brand = siteBrandForHost(host)
  const inline = brand ? INLINE_BRANDS.find((entry) => entry.key === brand.key) : undefined
  const [data, setData] = useState<BrandData | null>(() =>
    brand && !inline ? (getCachedSiteBrand(brand.key) ?? null) : null
  )

  useEffect(() => {
    if (!brand || inline) return
    const key: string = brand.key
    const cached = getCachedSiteBrand(key)
    if (cached) {
      setData(cached)
      return
    }
    setData(null)
    let cancelled = false
    loadSiteBrand(key)
      ?.then((loaded) => {
        if (!cancelled) setData(loaded)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
    return () => {
      cancelled = true
    }
  }, [brand, inline])

  if (!brand) {
    // Generic glyph while loading / for engines and unbranded hosts — never blank.
    const glyph = isSearchEngineHost(host) ? 'search' : 'globe'
    return (
      <span
        className="inline-flex shrink-0 items-center"
        data-site-brand={glyph}
      >
        <Icon
          name={glyph}
          size={size}
          className={cn('shrink-0 text-tertiary', className)}
        />
      </span>
    )
  }

  if (inline) {
    const color = resolveProviderBrandColor(inline.color, theme)
    return (
      <span className="inline-flex shrink-0 items-center" data-site-brand={inline.key}>
        <svg
          viewBox="0 0 24 24"
          width={size}
          height={size}
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
          style={{ color }}
          className={cn('shrink-0', className)}
        >
          <path d={inline.path} />
        </svg>
      </span>
    )
  }

  if (!data) {
    // Lazy module still loading — generic glyph, never blank.
    const glyph = isSearchEngineHost(host) ? 'search' : 'globe'
    return (
      <span
        className="inline-flex shrink-0 items-center"
        data-site-brand={brand.key}
      >
        <Icon
          name={glyph}
          size={size}
          className={cn('shrink-0 text-tertiary', className)}
        />
      </span>
    )
  }

  const color = resolveProviderBrandColor(data.colorPrimary, theme)
  return (
    <span className="inline-flex shrink-0 items-center" data-site-brand={brand.key}>
      <data.Component
        size={size}
        style={{ color }}
        className={cn('shrink-0', className)}
        aria-hidden="true"
      />
    </span>
  )
}
