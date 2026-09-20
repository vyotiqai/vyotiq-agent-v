import { useEffect, useRef, useState } from 'react'
import type { AppInfo, UpdaterStatePayload } from '@shared/ipc'
import { VyotiqLockup } from '@renderer/lib/brand'
import { Button, Switch } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import { checkForUpdates, useUpdaterState } from '@renderer/features/updates/updaterStore'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

/**
 * The three external links, as data. Each row was previously ~27 lines of
 * identical open/pending/error handling; the ids are load-bearing for settings
 * search, so they stay exactly as they were.
 */
const LINKS: readonly {
  id: string
  title: string
  hint: (info: AppInfo | null) => string
  href: (info: AppInfo) => string
}[] = [
  {
    id: 'about-website',
    title: 'Website',
    hint: (info) => (info ? websiteHost(info.homepage) : 'vyotiq.com'),
    href: (info) => info.homepage
  },
  {
    id: 'about-docs',
    title: 'Docs',
    hint: (info) => (info ? `${websiteHost(info.homepage)}/docs` : 'vyotiq.com/docs'),
    href: (info) => new URL('/docs', info.homepage).href
  },
  {
    id: 'about-source',
    title: 'Source',
    hint: () => 'github.com/vyotiqai/vyotiq-agent-v',
    href: () => 'https://github.com/vyotiqai/vyotiq-agent-v'
  }
]

// Module-level so render stays pure under React Compiler annotation mode
// (audit L3); Date access in a render body is an impurity.
const CURRENT_YEAR = new Date().getFullYear()

function platformLabel(platform: string, arch: string, osVersion: string): string {
  let os: string
  switch (platform) {
    case 'win32':
      os = 'Windows'
      break
    case 'darwin':
      os = 'macOS'
      break
    case 'linux':
      os = 'Linux'
      break
    default:
      os = platform
      break
  }
  return `${os} ${arch} · ${osVersion}`
}

function websiteHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function buildInfoText(info: AppInfo): string {
  return [
    `${info.name} ${info.version}`,
    `Electron ${info.electron}`,
    `Chromium ${info.chrome}`,
    `Node.js ${info.node}`,
    `Platform ${info.platform} ${info.arch} (${info.osVersion})`,
    info.homepage
  ].join('\n')
}

function updaterHint(payload: UpdaterStatePayload): string {
  switch (payload.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return payload.info?.version
        ? `Version ${payload.info.version} is available.`
        : 'An update is available.'
    case 'downloading':
      return payload.progress != null
        ? `Downloading ${Math.round(payload.progress.percent)}%`
        : 'Downloading update…'
    case 'downloaded':
      return 'Restart to install the downloaded update.'
    case 'not-available':
      return 'This install is current.'
    case 'error':
      return payload.error ?? 'Update check failed. Try again.'
    default:
      // Idle: nothing checked yet this session (before the startup check,
      // or in dev). Say what the button does, not where the bits live.
      return 'Check for a newer version.'
  }
}

export function AboutSection({ form }: { form: SettingsFormState }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const updater = useUpdaterState()
  const setErrorMessage = form.setErrorMessage
  const setErrorRef = useRef(setErrorMessage)
  setErrorRef.current = setErrorMessage
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const api = window.vyotiq?.getAppInfo
    if (!api) return
    void api()
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setErrorRef.current(res.error)
          return
        }
        setInfo(res.data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setErrorRef.current(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  const dash = '—'
  const status = updater.status
  const canCheck = status !== 'checking' && status !== 'downloading'
  const updateVersionShown =
    info?.version != null &&
    updater.info?.version != null &&
    (status === 'available' || status === 'downloading' || status === 'downloaded')

  const openLink = (id: string, url: string): void => {
    if (!window.vyotiq?.shellOpenExternal) return
    form.clearErrors()
    setOpeningId(id)
    void window.vyotiq
      .shellOpenExternal(url)
      .then((res) => {
        if (!res.ok) form.setErrorMessage(res.error)
      })
      .catch((err: unknown) => {
        form.setErrorMessage(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setOpeningId(null))
  }

  return (
    <SettingsStack>
      <div
        data-settings-field="about"
        className="rounded-xl border border-border/70 bg-surface p-5"
      >
        <div className="flex flex-col gap-2">
          <VyotiqLockup markSize={36} />
          <p className="m-0 text-xs leading-snug tracking-[var(--vy-tracking)] text-secondary">
            Agent V. A product of Vyotiq.com.
          </p>
          <p className="m-0 text-xs leading-snug tracking-[var(--vy-tracking)] text-muted">
            © {CURRENT_YEAR} Vyotiq. Agent V is free software licensed under GPL-3.0-or-later.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {LINKS.map((link) => (
              <button
                key={link.id}
                type="button"
                data-settings-field={link.id}
                disabled={!info}
                title={link.hint(info)}
                className="m-0 rounded-sm text-xs tracking-[var(--vy-tracking)] text-secondary underline-offset-2 hover:text-fg hover:underline focus-visible:outline focus-visible:outline-accent disabled:opacity-60"
                onClick={() => {
                  if (!info) return
                  openLink(link.id, link.href(info))
                }}
              >
                {openingId === link.id ? 'Opening…' : link.title}
              </button>
            ))}
          </div>
        </div>
      </div>

      <SettingsGroup title="Build">
        <SettingsField
          id="about-version"
          title="Version"
          hint="Product version for this install."
        >
          <p className="m-0 text-sm tabular-nums tracking-[var(--vy-tracking)] text-fg">
            {info?.version ?? dash}
          </p>
        </SettingsField>
        <SettingsField
          id="about-runtime"
          title="Runtime"
          hint="Electron host, Chromium, and Node.js shipped in this app."
          wide
        >
          <dl className="m-0 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm tracking-[var(--vy-tracking)]">
            <dt className="text-secondary">Electron</dt>
            <dd className="m-0 min-w-0 tabular-nums text-fg">{info?.electron ?? dash}</dd>
            <dt className="text-secondary">Chromium</dt>
            <dd className="m-0 min-w-0 break-all tabular-nums text-fg">{info?.chrome ?? dash}</dd>
            <dt className="text-secondary">Node.js</dt>
            <dd className="m-0 min-w-0 tabular-nums text-fg">{info?.node ?? dash}</dd>
          </dl>
        </SettingsField>
        <SettingsField
          id="about-platform"
          title="Platform"
          hint="Operating system and architecture reported by the host."
        >
          <p className="m-0 max-w-full text-right text-sm tracking-[var(--vy-tracking)] text-fg [overflow-wrap:anywhere]">
            {info ? platformLabel(info.platform, info.arch, info.osVersion) : dash}
          </p>
        </SettingsField>
        <SettingsField
          id="about-copy"
          title="Build info"
          hint="Copy version and runtime lines for a bug report."
        >
          <Button
            variant="subtle"
            disabled={!info}
            onClick={() => {
              if (!info) return
              void copyText(buildInfoText(info)).then((ok) => {
                if (!ok) {
                  form.setErrorMessage('Could not copy build info.')
                  return
                }
                setCopied(true)
                if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
                copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Updates">
        <SettingsField
          id="about-auto-check"
          title="Automatic checks"
          hint="Look for new releases at startup and every 6 hours. Nothing is ever downloaded on its own."
        >
          <Switch
            size="md"
            checked={form.settings.autoCheckUpdates}
            disabled={form.formLocked}
            label="Check for updates automatically"
            onCheckedChange={(checked) => {
              void form.runUpdate({ autoCheckUpdates: checked })
            }}
          />
        </SettingsField>
        <SettingsField id="about-updater" title="App updates" hint={updaterHint(updater)}>
          {updateVersionShown ? (
            <p className="m-0 text-xs tabular-nums tracking-[var(--vy-tracking)] text-muted">
              {info?.version} <span aria-hidden="true">→</span> {updater.info?.version}
            </p>
          ) : null}
          {/* Download and install live in the sidebar update panel, which is
              showing exactly when those actions are available. One place to
              start an irreversible restart is enough. */}
          <Button
            variant="subtle"
            pending={checking || status === 'checking'}
            disabled={!canCheck || checking || !window.vyotiq?.updater}
            onClick={() => {
              form.clearErrors()
              setChecking(true)
              void checkForUpdates()
                .catch((err: unknown) => {
                  form.setErrorMessage(err instanceof Error ? err.message : String(err))
                })
                .finally(() => setChecking(false))
            }}
          >
            {status === 'checking' ? 'Checking…' : 'Check'}
          </Button>
        </SettingsField>
      </SettingsGroup>

    </SettingsStack>
  )
}
