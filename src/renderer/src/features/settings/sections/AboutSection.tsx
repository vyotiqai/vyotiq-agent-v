import { useEffect, useRef, useState } from 'react'
import type { AppInfo, UpdaterStatePayload } from '@shared/ipc'
import { VyotiqLockup } from '@renderer/lib/brand'
import { Button, Switch } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

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

function updaterHint(payload: UpdaterStatePayload | null): string {
  if (!payload) return 'Check GitHub Releases for a newer install.'
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
      return 'Check GitHub Releases for a newer install.'
  }
}

export function AboutSection({ form }: { form: SettingsFormState }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [openingSite, setOpeningSite] = useState(false)
  const [openingDocs, setOpeningDocs] = useState(false)
  const [updater, setUpdater] = useState<UpdaterStatePayload | null>(null)
  const [updaterBusy, setUpdaterBusy] = useState(false)
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

  useEffect(() => {
    let cancelled = false
    const api = window.vyotiq
    if (!api?.updater) return
    // The push channel is schema-gated in preload; one explicit check seeds
    // the current state (same as pressing the Check button).
    void api.updater.check().catch((err: unknown) => {
      if (!cancelled) setErrorRef.current(err instanceof Error ? err.message : String(err))
    })
    const stop = api.updater.onState((payload) => {
      if (!cancelled) setUpdater(payload)
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [])

  const dash = '—'
  const year = new Date().getFullYear()
  const status = updater?.status
  const canCheck = status !== 'checking' && status !== 'downloading'
  const canDownload = status === 'available'
  const canInstall = status === 'downloaded'
  const updateVersionShown =
    info?.version != null &&
    updater?.info?.version != null &&
    (status === 'available' || status === 'downloading' || status === 'downloaded')
  const downloadPct =
    status === 'downloading' && updater?.progress != null
      ? Math.max(0, Math.min(100, Math.round(updater.progress.percent)))
      : null

  const runUpdater = (fn: () => Promise<{ ok: boolean; error?: string }> | undefined): void => {
    const task = fn()
    if (!task) return
    form.clearErrors()
    setUpdaterBusy(true)
    void task
      .then((res) => {
        if (!res.ok) form.setErrorMessage(res.error ?? 'Update failed')
      })
      .catch((err: unknown) => {
        form.setErrorMessage(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setUpdaterBusy(false))
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
            © {year} Vyotiq. Agent V is proprietary Vyotiq software. All rights reserved.
          </p>
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
          hint="Look for GitHub Releases when the app starts."
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
              {info?.version} <span aria-hidden="true">→</span> {updater?.info?.version}
            </p>
          ) : null}
          {downloadPct != null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-sm bg-border"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={downloadPct}
              aria-label="Update download progress"
            >
              <div
                className="h-full bg-accent transition-[width] duration-100 ease-linear"
                style={{ width: `${downloadPct}%` }}
              />
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button
              variant="subtle"
              pending={updaterBusy && status === 'checking'}
              disabled={!canCheck || updaterBusy || !window.vyotiq?.updater}
              onClick={() => runUpdater(() => window.vyotiq?.updater.check())}
            >
              {status === 'checking' ? 'Checking…' : 'Check'}
            </Button>
            {canDownload || status === 'downloading' ? (
              <Button
                variant="subtle"
                pending={status === 'downloading'}
                disabled={!canDownload || updaterBusy || !window.vyotiq?.updater}
                onClick={() => runUpdater(() => window.vyotiq?.updater.download())}
              >
                {status === 'downloading' ? 'Downloading…' : 'Download'}
              </Button>
            ) : null}
            {canInstall ? (
              <Button
                variant="primary"
                disabled={updaterBusy || !window.vyotiq?.updater}
                onClick={() => runUpdater(() => window.vyotiq?.updater.install())}
              >
                Restart to install
              </Button>
            ) : null}
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Links">
        <SettingsField
          id="about-website"
          title="Website"
          hint={info ? websiteHost(info.homepage) : 'vyotiq.com'}
        >
          <Button
            variant="subtle"
            pending={openingSite}
            disabled={!info}
            onClick={() => {
              if (!info || !window.vyotiq?.shellOpenExternal) return
              form.clearErrors()
              setOpeningSite(true)
              void window.vyotiq
                .shellOpenExternal(info.homepage)
                .then((res) => {
                  if (!res.ok) form.setErrorMessage(res.error)
                })
                .catch((err: unknown) => {
                  form.setErrorMessage(err instanceof Error ? err.message : String(err))
                })
                .finally(() => setOpeningSite(false))
            }}
          >
            {openingSite ? 'Opening…' : 'Open'}
          </Button>
        </SettingsField>
        <SettingsField
          id="about-docs"
          title="Docs"
          hint={info ? `${websiteHost(info.homepage)}/docs` : 'vyotiq.com/docs'}
        >
          <Button
            variant="subtle"
            pending={openingDocs}
            disabled={!info}
            onClick={() => {
              if (!info || !window.vyotiq?.shellOpenExternal) return
              form.clearErrors()
              setOpeningDocs(true)
              void window.vyotiq
                .shellOpenExternal(new URL('/docs', info.homepage).href)
                .then((res) => {
                  if (!res.ok) form.setErrorMessage(res.error)
                })
                .catch((err: unknown) => {
                  form.setErrorMessage(err instanceof Error ? err.message : String(err))
                })
                .finally(() => setOpeningDocs(false))
            }}
          >
            {openingDocs ? 'Opening…' : 'Open'}
          </Button>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
