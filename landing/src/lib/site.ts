import app from '../data/app.json'
import release from '../data/release.json'

/** Every route and link the site renders; verify-site.mjs checks each one resolves. */

export const SITE = {
  name: 'Vyotiq',
  product: 'Agent V',
  url: 'https://vyotiq.com',
  title: 'Agent V — a coding workspace for real repositories',
  description:
    'Agent V is an open source desktop coding agent that works directly on your checked-out repository — terminal, files, git and GitHub — with the model provider and API key of your choice. Free for Windows, macOS and Linux.'
} as const

export type NavItem = { href: string; label: string }

export const NAV: NavItem[] = [
  { href: '/features', label: 'Features' },
  { href: '/extensions', label: 'Extensions' },
  { href: '/docs', label: 'Docs' },
  { href: '/changelog', label: 'Changelog' }
]

export const FOOTER: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Product',
    items: [
      { href: '/features', label: 'Features' },
      { href: '/extensions', label: 'Extensions' },
      { href: '/download', label: 'Download' },
      { href: '/changelog', label: 'Changelog' }
    ]
  },
  {
    heading: 'Resources',
    items: [
      { href: '/docs', label: 'Documentation' },
      { href: app.repo.source, label: 'Source on GitHub' },
      { href: app.repo.releases, label: 'Releases' },
      { href: app.repo.issues ?? `${app.repo.source}/issues`, label: 'Issue tracker' },
      { href: '/contributing', label: 'Contributing' }
    ]
  },
  {
    heading: 'Legal',
    items: [
      { href: '/license', label: 'License' },
      { href: '/privacy', label: 'Privacy' },
      { href: '/terms', label: 'Terms' },
      { href: '/security', label: 'Security' },
      { href: '/notice', label: 'Third-party notices' },
      { href: '/code-of-conduct', label: 'Code of conduct' }
    ]
  }
]

export const isExternal = (href: string): boolean => /^https?:\/\//.test(href)

/** 147179381 -> "140 MB". Release asset sizes come back as raw bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

export { app, release }
