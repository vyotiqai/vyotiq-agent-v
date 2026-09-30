import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_NETWORK_SETTINGS, type NetworkSettings, type ProxyMode } from '@shared/ipc'
import { normalizeProxyBypass, validateProxyUrl, type ProxyStatus } from '@shared/domain/network'
import { Icon } from '@renderer/lib/icons'
import { Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsOption } from '../types'
import { SegmentedField } from './SegmentedField'
import { SettingsField, SettingsGroup } from './SettingsField'

const PROXY_MODE_OPTIONS: SettingsOption<ProxyMode>[] = [
  { value: 'system', label: 'System' },
  { value: 'manual', label: 'Manual' },
  { value: 'direct', label: 'None' }
]

const SOURCE_WORDS: Record<ProxyStatus['source'], string> = {
  manual: 'the address set here',
  environment: 'HTTPS_PROXY',
  system: 'the system proxy',
  none: ''
}

/** What main is actually using, in one line under the mode. */
function ProxyStatusLine({ status }: { status: ProxyStatus | null }) {
  if (!status) return null
  return (
    <div className="flex flex-col gap-1" data-proxy-status={status.source}>
      <p className="m-0 text-caption text-muted">
        {status.source === 'none' ? (
          'Direct connection'
        ) : (
          <>
            <span className="font-mono">{status.url}</span> · from {SOURCE_WORDS[status.source]}
          </>
        )}
      </p>
      {status.note ? (
        <p className="m-0 flex items-center gap-1.5 text-xs text-warning" role="status">
          <Icon name="warning" size={13} />
          {status.note}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Settings → General → Network: the proxy every main-process call uses —
 * providers, MCP servers, updates, downloads — and the one the agent's
 * terminal and browser get.
 */
export function NetworkGroup({ form }: { form: SettingsFormState }) {
  const net: NetworkSettings = form.settings.network ?? DEFAULT_NETWORK_SETTINGS
  const [status, setStatus] = useState<ProxyStatus | null>(null)
  const [url, setUrl] = useState(net.proxyUrl)
  const [bypass, setBypass] = useState(net.proxyBypass)
  const [urlError, setUrlError] = useState<string | null>(null)

  const refreshStatus = useCallback(() => {
    void window.vyotiq
      ?.networkProxyStatus?.()
      .then((res) => {
        if (res.ok) setStatus(res.data)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => refreshStatus(), [refreshStatus])
  useEffect(() => setUrl(net.proxyUrl), [net.proxyUrl])
  useEffect(() => setBypass(net.proxyBypass), [net.proxyBypass])

  const save = async (patch: Partial<NetworkSettings>): Promise<void> => {
    const ok = await form.runUpdate({ network: { ...net, ...patch } })
    if (ok) refreshStatus()
  }

  const commitUrl = (): void => {
    if (url.trim() === net.proxyUrl) {
      setUrlError(null)
      return
    }
    const parsed = validateProxyUrl(url)
    setUrlError(parsed.ok ? null : parsed.error)
    if (parsed.ok) {
      setUrl(parsed.url)
      void save({ proxyUrl: parsed.url })
    }
  }

  const commitBypass = (): void => {
    const next = normalizeProxyBypass(bypass)
    setBypass(next)
    if (next !== net.proxyBypass) void save({ proxyBypass: next })
  }

  return (
    <SettingsGroup title="Network" description="Provider calls, MCP servers, updates and downloads.">
      <SegmentedField
        id="proxy-mode"
        title="Proxy"
        hint={
          net.proxyMode === 'system'
            ? 'HTTPS_PROXY when it is set, otherwise the operating system’s proxy.'
            : net.proxyMode === 'manual'
              ? 'The address below, for everything but the hosts listed.'
              : 'Connect directly, even when the system has a proxy.'
        }
        value={net.proxyMode}
        options={PROXY_MODE_OPTIONS}
        disabled={form.formLocked}
        onChange={(proxyMode) => {
          void save({ proxyMode })
        }}
        below={<ProxyStatusLine status={status} />}
        {...form.nestedDefaultMark('network', 'proxyMode')}
      />
      {net.proxyMode === 'manual' ? (
        <>
          <SettingsField
            id="proxy-url"
            title="Proxy address"
            hint="http://host:port. For a proxy that needs a password, set HTTPS_PROXY instead."
            nested
          >
            <div className="flex w-[240px] flex-col gap-1">
              <Input
                size="sm"
                mono
                aria-label="Proxy address"
                aria-invalid={urlError ? true : undefined}
                aria-describedby={urlError ? 'proxy-url-error' : undefined}
                placeholder="http://proxy.example.com:8080"
                spellCheck={false}
                disabled={form.formLocked}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={commitUrl}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
              {urlError ? (
                <p id="proxy-url-error" className="m-0 text-xs text-danger" role="alert">
                  {urlError}
                </p>
              ) : null}
            </div>
          </SettingsField>
          <SettingsField
            id="proxy-bypass"
            title="Skip the proxy for"
            hint="Hosts, comma-separated. This computer is always skipped."
            nested
          >
            <div className="w-[240px]">
              <Input
                size="sm"
                mono
                aria-label="Hosts that skip the proxy"
                placeholder="*.internal, 10.0.0.5"
                spellCheck={false}
                disabled={form.formLocked}
                value={bypass}
                onChange={(e) => setBypass(e.target.value)}
                onBlur={commitBypass}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
            </div>
          </SettingsField>
        </>
      ) : null}
    </SettingsGroup>
  )
}
