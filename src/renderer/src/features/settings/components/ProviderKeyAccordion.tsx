import { type ReactNode } from 'react'
import { SECRET_PROVIDERS, type SecretProvider } from '@shared/ipc'
import { CUSTOM_OPENAI_DEFAULT, normalizeCustomOpenAiBaseUrl, providerLabel } from '@shared/providers'
import { Icon } from '@renderer/lib/icons'
import { Badge, Input, Button, cn } from '@renderer/lib/ui'
import type { SettingsErrorField } from '../types'

export type ProviderBaseUrlFieldState = {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  error: ReactNode
}

export function ProviderKeyAccordion({
  secrets,
  settingsProvider,
  encryptionAvailable,
  keyProvider,
  keyDraft,
  keyHasSaved,
  keyProviderLabel,
  formLocked,
  savingKey,
  clearingKey,
  errorField,
  displayError,
  ollamaUrl,
  customUrl,
  onKeyDraftChange,
  onSelectProvider,
  onSetActive,
  onSaveKey,
  onClearKey
}: {
  secrets: Record<SecretProvider, boolean>
  settingsProvider: SecretProvider
  encryptionAvailable: boolean
  keyProvider: SecretProvider
  keyDraft: string
  keyHasSaved: boolean
  keyProviderLabel: string
  formLocked: boolean
  savingKey: boolean
  clearingKey: boolean
  errorField: SettingsErrorField
  displayError: string | null
  ollamaUrl: ProviderBaseUrlFieldState
  customUrl: ProviderBaseUrlFieldState
  onKeyDraftChange: (value: string) => void
  onSelectProvider: (provider: SecretProvider) => void
  onSetActive: (provider: SecretProvider) => void
  onSaveKey: () => void
  onClearKey: () => void
}) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <ul
        className="m-0 flex list-none flex-col divide-y divide-border/60 p-0"
        aria-label="API key status"
      >
        {SECRET_PROVIDERS.map((id) => {
          const saved = secrets[id]
          const expanded = id === keyProvider
          const isActive = id === settingsProvider
          const hasBaseUrl = id === 'custom' || id === 'ollama'
          const settingsFieldId =
            id === 'custom' ? 'custom-url' : id === 'ollama' ? 'ollama-url' : undefined
          const rowUrl = id === 'custom' ? customUrl.value : id === 'ollama' ? ollamaUrl.value : ''
          const collapsedHost = !expanded && hasBaseUrl ? providerHostPreview(rowUrl) : ''
          const warnLocalDefault =
            id === 'custom' &&
            isActive &&
            saved &&
            normalizeCustomOpenAiBaseUrl(customUrl.value) === CUSTOM_OPENAI_DEFAULT
          return (
            <li key={id} data-settings-field={settingsFieldId}>
              {/* Bleeds 6px past the row edge on both sides so the hover fill
                  frames the text while the chevron stays on the column edge. */}
              <button
                type="button"
                className={cn(
                  '-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-2 text-left text-xs tracking-[var(--vy-tracking)]',
                  'vy-transition hover:bg-surface-2 focus-visible:vy-focus-ring disabled:vy-disabled-state'
                )}
                aria-expanded={expanded}
                disabled={formLocked || (!encryptionAvailable && !saved && !hasBaseUrl)}
                onClick={() => onSelectProvider(id)}
              >
                <Icon
                  name="chevron"
                  size={12}
                  className={cn('shrink-0 text-muted vy-transition', expanded ? '' : '-rotate-90')}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">{providerLabel(id)}</span>
                  {collapsedHost ? (
                    <span className="mt-0.5 block truncate text-2xs text-muted" title={rowUrl}>
                      {collapsedHost}
                    </span>
                  ) : null}
                </span>
                {isActive ? (
                  <Badge tone="accent">Active</Badge>
                ) : saved ? (
                  <Badge>Saved</Badge>
                ) : (
                  <span className="shrink-0 text-2xs text-muted">
                    {encryptionAvailable ? 'No key' : 'Unavailable'}
                  </span>
                )}
              </button>
              {expanded ? (
                <div className="flex flex-col gap-2 pb-3 pl-5 pt-1">
                  {id === 'custom' ? (
                    <ProviderBaseUrlField
                      inputId="custom-openai-url"
                      ariaLabel="Custom OpenAI base URL"
                      label="Base URL"
                      hint="OpenAI-compatible base (…/v1 or vendor mount)."
                      example="https://api.deepinfra.com/v1/openai"
                      value={customUrl.value}
                      disabled={formLocked}
                      invalid={errorField === 'customUrl'}
                      describedBy={errorField === 'customUrl' ? 'custom-url-error' : undefined}
                      error={customUrl.error}
                      onChange={customUrl.onChange}
                      onCommit={customUrl.onCommit}
                    />
                  ) : null}
                  {warnLocalDefault ? (
                    <p className="m-0 text-xs leading-snug text-warning" role="status">
                      Base URL is still the local default (127.0.0.1:8080). Hosted providers need
                      their own endpoint.
                    </p>
                  ) : null}
                  {id === 'ollama' ? (
                    <ProviderBaseUrlField
                      inputId="ollama"
                      ariaLabel="Ollama base URL"
                      label="Base URL"
                      hint="Local daemon by default. Saving an API key switches to Cloud (https://ollama.com). Loopback stays key-optional."
                      value={ollamaUrl.value}
                      disabled={formLocked}
                      invalid={errorField === 'ollama'}
                      describedBy={errorField === 'ollama' ? 'ollama-error' : undefined}
                      error={ollamaUrl.error}
                      onChange={ollamaUrl.onChange}
                      onCommit={ollamaUrl.onCommit}
                    />
                  ) : null}
                  {id === 'opencode' ? (
                    <div className="flex flex-col gap-1">
                      <p className="m-0 text-xs leading-snug text-secondary">
                        Subscribe to OpenCode Go, then paste the API key from its console.
                      </p>
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          className="rounded-sm text-xs text-secondary underline underline-offset-2 vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
                          onClick={() => window.vyotiq.shellOpenExternal('https://opencode.ai/go')}
                        >
                          Subscribe — $10/mo
                        </button>
                        <button
                          type="button"
                          className="rounded-sm text-xs text-secondary underline underline-offset-2 vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
                          onClick={() => window.vyotiq.shellOpenExternal('https://opencode.ai/auth')}
                        >
                          Get API key
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <Input
                    id="apikey"
                    className="w-full"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`API key (${keyProviderLabel})`}
                    aria-invalid={errorField === 'apikey' ? true : undefined}
                    aria-describedby={errorField === 'apikey' ? 'apikey-error' : undefined}
                    value={keyDraft}
                    placeholder={
                      !encryptionAvailable
                        ? 'Secure storage unavailable'
                        : keyHasSaved
                          ? '•••••••• (saved)'
                          : 'Paste API key'
                    }
                    disabled={!encryptionAvailable || savingKey || clearingKey}
                    onChange={(e) => onKeyDraftChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && keyDraft.trim() && !savingKey) {
                        e.preventDefault()
                        onSaveKey()
                      }
                    }}
                  />
                  {id === 'custom' ? (
                    <p className="m-0 text-xs leading-snug text-secondary">
                      Public hosts need a key; loopback and private LAN can stay empty.
                    </p>
                  ) : null}
                  {errorField === 'apikey' && displayError ? (
                    <p id="apikey-error" className="m-0 w-full text-xs text-danger" role="alert">
                      {displayError}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="primary"
                      pending={savingKey}
                      disabled={!encryptionAvailable || !keyDraft.trim() || clearingKey}
                      onClick={onSaveKey}
                    >
                      {savingKey ? 'Saving…' : 'Save key'}
                    </Button>
                    {keyHasSaved ? (
                      <Button
                        variant="subtle"
                        pending={clearingKey}
                        disabled={savingKey}
                        onClick={onClearKey}
                      >
                        {clearingKey ? 'Clearing…' : 'Clear'}
                      </Button>
                    ) : null}
                    {!isActive ? (
                      <Button
                        variant="subtle"
                        disabled={formLocked}
                        onClick={() => onSetActive(id)}
                      >
                        Set as active
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ProviderBaseUrlField({
  inputId,
  ariaLabel,
  label,
  hint,
  example,
  value,
  disabled,
  invalid,
  describedBy,
  error,
  onChange,
  onCommit
}: {
  inputId: string
  ariaLabel: string
  label: string
  hint: string
  example?: string
  value: string
  disabled: boolean
  invalid: boolean
  describedBy?: string
  error: ReactNode
  onChange: (value: string) => void
  onCommit: () => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <p className="m-0 text-xs tracking-[var(--vy-tracking)] text-fg-strong">{label}</p>
        <p className="m-0 mt-0.5 text-xs leading-snug tracking-[var(--vy-tracking)] text-secondary">
          {hint}
        </p>
      </div>
      <Input
        id={inputId}
        className="w-full"
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          onCommit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
      />
      {example ? (
        <p className="m-0 text-xs leading-snug text-muted [overflow-wrap:anywhere]">
          Example: {example}
        </p>
      ) : null}
      {error}
    </div>
  )
}

/** Compact host (+ vendor path) for a collapsed Custom/Ollama row. */
function providerHostPreview(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
    const path = parsed.pathname.replace(/\/+$/, '')
    if (path && path !== '/' && !/^\/v1$/i.test(path)) {
      return `${parsed.host}${path}`
    }
    return parsed.host
  } catch {
    return trimmed
  }
}
