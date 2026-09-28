/** Links and navigation shared by every page. */

export const REPO = 'https://github.com/vyotiqai/vyotiq-agent-v'
export const RELEASES_REPO = 'vyotiqai/vyotiq-agent-v-releases'
export const RELEASES = `https://github.com/${RELEASES_REPO}/releases`
export const LATEST_RELEASE = `${RELEASES}/latest`
export const ISSUES = `${REPO}/issues`
export const ORG = 'https://github.com/vyotiqai'
export const LICENSE = 'https://www.gnu.org/licenses/gpl-3.0.html'

export const TAGLINE = 'Agent V is a desktop coding agent. Write what you want and how you will know it is done; it does the work and shows you every step.'

export type NavLink = { label: string; href: string }

export const MAIN_NAV: NavLink[] = [
  { label: 'Features', href: '/features/' },
  { label: 'Use cases', href: '/use-cases/' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Extensions', href: '/extensions' },
  { label: 'Changelog', href: '/changelog' },
  { label: 'Privacy', href: '/privacy' }
]

export const FOOTER_NAV: { label: string; links: NavLink[] }[] = [
  {
    label: 'Product',
    links: [
      { label: 'Features', href: '/features/' },
      { label: 'Extensions', href: '/extensions' },
      { label: 'Download', href: '/download' },
      { label: 'Changelog', href: '/changelog' }
    ]
  },
  {
    label: 'Learn',
    links: [
      { label: 'Use cases', href: '/use-cases/' },
      { label: 'Docs', href: '/docs/' },
      { label: 'FAQ', href: '/faq' },
      { label: 'Source', href: REPO }
    ]
  },
  {
    label: 'Trust',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Security', href: '/security' },
      { label: 'Terms', href: '/terms' },
      { label: 'License', href: LICENSE }
    ]
  },
  {
    label: 'Connect',
    links: [
      { label: 'GitHub', href: ORG },
      { label: 'Report an issue', href: ISSUES }
    ]
  }
]
