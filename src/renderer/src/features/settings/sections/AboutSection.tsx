import { useEffect, useRef, useState } from 'react'
import type { AppInfo, UpdaterStatePayload } from '@shared/ipc'
import { VyotiqMark } from '@renderer/lib/brand'
import { Button, ProgressBar } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  useUpdaterState
} from '@renderer/features/updates/updaterStore'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsGroup, SettingsItem, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

const SOURCE_URL = 'https://github.com/vyotiqai/vyotiq-agent-v'

function osLabel(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    default:
      return platform
  }
}

/** "1.0.0 · Electron 43.2.0 · Chromium 150.0.… · Node 24.18.0 · Windows x64". */
function buildLine(info: AppInfo): string {
  return [
    info.version,
    `Electron ${info.electron}`,
    `Chromium ${info.chrome}`,
    `Node ${info.node}`,
    `${osLabel(info.platform)} ${info.arch}`
  ].join(' · ')
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

/**
 * The update row names the state it is in — "Version 1.1.0 is ready" — and
 * offers the one step that moves it on. The actions are the update store's,
 * the same ones the sidebar entry runs; nothing here subscribes on its own.
 */
function updateRow(payload: UpdaterStatePayload, current: string | null): { title: string; hint: string } {
  const next = payload.info?.version
  switch (payload.status) {
    case 'checking':
      return { title: 'Checking for updates…', hint: current ? `This is ${current}.` : '' }
    case 'available':
      return {
        title: next ? `Version ${next} is available` : 'An update is available',
        hint: 'Nothing downloads until you ask.'
      }
    case 'downloading':
      return {
        title: next ? `Downloading version ${next}` : 'Downloading the update',
        hint: payload.progress != null ? `${Math.round(payload.progress.percent)}%` : 'Starting…'
      }
    case 'downloaded':
      return {
        title: next ? `Version ${next} is ready` : 'The update is ready',
        hint: 'Downloaded · restart to install'
      }
    case 'not-available':
      return { title: 'Up to date', hint: current ? `${current} is the newest release.` : 'This is the newest release.' }
    case 'error':
      return { title: 'The update check failed', hint: payload.error ?? 'Try again.' }
    default:
      // Idle: nothing checked yet this session (before the startup check, or
      // in dev). Say so rather than implying an answer.
      return { title: 'Not checked yet', hint: current ? `This is ${current}.` : '' }
  }
}

export function AboutSection({
  form,
  onOpenFeedback
}: {
  form: SettingsFormState
  onOpenFeedback: () => void
}) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)
  const updater = useUpdaterState()
  const setErrorRef = useRef(form.setErrorMessage)
  setErrorRef.current = form.setErrorMessage
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

  const status = updater.status
  const bridge = Boolean(window.vyotiq?.updater)
  const row = updateRow(updater, info?.version ?? null)

  const openLink = (url: string): void => {
    if (!window.vyotiq?.shellOpenExternal) return
    form.clearErrors()
    void window.vyotiq
      .shellOpenExternal(url)
      .then((res) => {
        if (!res.ok) form.setErrorMessage(res.error)
      })
      .catch((err: unknown) => {
        form.setErrorMessage(err instanceof Error ? err.message : String(err))
      })
  }

  const copyBuildInfo = (): void => {
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
  }

  const check = (): void => {
    form.clearErrors()
    setChecking(true)
    void checkForUpdates()
      .catch((err: unknown) => {
        form.setErrorMessage(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setChecking(false))
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Agent V" fieldId="about" plain>
        <div className="mt-2 flex items-start gap-4">
          <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-surface text-fg-strong">
            <VyotiqMark size={28} decorative />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-heading font-semibold text-fg-strong">Agent V</div>
            <div
              className="font-mono text-xs text-muted tnum [overflow-wrap:anywhere]"
              title={info ? `${osLabel(info.platform)} ${info.osVersion}` : undefined}
            >
              {info ? buildLine(info) : '—'}
            </div>
            <div className="mt-2 text-xs text-muted">A product of Vyotiq.com · free software under GPL-3.0-or-later</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button
                size="xs"
                variant="ghost"
                icon={copied ? 'check' : 'copy'}
                data-settings-field="about-copy"
                disabled={!info}
                onClick={copyBuildInfo}
              >
                {copied ? 'Copied' : 'Copy build info'}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                icon="external"
                data-settings-field="about-docs"
                disabled={!info}
                onClick={() => {
                  if (info) openLink(new URL('/docs', info.homepage).href)
                }}
              >
                Docs
              </Button>
              <Button
                size="xs"
                variant="ghost"
                icon="external"
                data-settings-field="about-source"
                onClick={() => openLink(SOURCE_URL)}
              >
                Source
              </Button>
              <Button
                size="xs"
                variant="ghost"
                icon="external"
                data-settings-field="about-website"
                disabled={!info}
                onClick={() => {
                  if (info) openLink(info.homepage)
                }}
              >
                Website
              </Button>
            </div>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Updates" fieldId="about-updater">
        <SwitchField
          id="about-auto-check"
          title="Check automatically"
          label="Check for updates automatically"
          hint="At start and every 6 hours. Nothing downloads on its own."
          checked={form.settings.autoCheckUpdates}
          disabled={form.formLocked}
          {...form.defaultMark('autoCheckUpdates')}
          onChange={(autoCheckUpdates) => {
            void form.runUpdate({ autoCheckUpdates })
          }}
        />
        <SettingsItem
          id="update-status"
          title={row.title}
          hint={row.hint || undefined}
          below={
            status === 'downloading' && updater.progress != null ? (
              <ProgressBar value={updater.progress.percent} max={100} tone="accent" label="Update download" />
            ) : null
          }
        >
          {status === 'downloaded' ? (
            <Button size="sm" variant="primary" disabled={!bridge} onClick={installUpdate}>
              Restart and install
            </Button>
          ) : status === 'available' ? (
            <Button size="sm" variant="secondary" disabled={!bridge} onClick={downloadUpdate}>
              Download
            </Button>
          ) : status === 'downloading' ? null : (
            <Button
              size="sm"
              variant="secondary"
              pending={checking || status === 'checking'}
              disabled={!bridge || checking || status === 'checking'}
              onClick={check}
            >
              {status === 'checking' ? 'Checking…' : status === 'error' ? 'Try again' : 'Check now'}
            </Button>
          )}
        </SettingsItem>
      </SettingsGroup>

      <SettingsGroup title="Feedback">
        <SettingsField
          id="send-feedback"
          title="Send feedback"
          hint="Opens a pre-filled email to support@vyotiq.com."
          help="Report a bug, ask for a feature, or say what works. Optional diagnostics add the app version, OS, and locale — never chat contents."
        >
          <Button size="sm" variant="secondary" onClick={onOpenFeedback}>
            Write…
          </Button>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
