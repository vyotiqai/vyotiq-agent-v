import { useId, type ReactNode } from 'react'
import type { ProviderId, SecretProvider } from '@shared/ipc'
import {
  CUSTOM_OPENAI_DEFAULT,
  normalizeCustomOpenAiBaseUrl,
  providerLabel,
  providerNeedsKey
} from '@shared/providers'
import { Icon } from '@renderer/lib/icons'
import { Button, Input } from '@renderer/lib/ui'
import { ProviderLogo } from '@renderer/features/chat/components/composer/ProviderLogo'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { PROVIDER_KEY_ORDER, PROVIDER_KEY_URLS } from '../constants'

type KeyState = 'saved' | 'local' | 'none' | 'unavailable'

/**
 * Every provider as one row: its mark, whether it is the one new tasks use,
 * and whether it has a key. One row opens at a time, for its key and — for
 * Ollama and custom endpoints — its base URL.
 */
export function ProviderKeys({
  form,
  secrets,
  onClearKey
}: {
  form: SettingsFormState
  secrets: Record<SecretProvider, boolean>
  onClearKey: () => void
}) {
  return (
    <>
      {PROVIDER_KEY_ORDER.map((id) => (
        <ProviderKeyRow key={id} id={id} form={form} saved={secrets[id]} onClearKey={onClearKey} />
      ))}
    </>
  )
}

function ProviderKeyRow({
  id,
  form,
  saved,
  onClearKey
}: {
  id: ProviderId
  form: SettingsFormState
  saved: boolean
  onClearKey: () => void
}) {
  const panelId = useId()
  const label = providerLabel(id)
  const open = form.openKeyProvider === id
  const inUse = id === form.settings.provider
  const url = id === 'ollama' ? form.ollamaUrl : id === 'custom' ? form.customUrl : ''
  const state: KeyState = saved
    ? 'saved'
    : (id === 'ollama' || id === 'custom') && !providerNeedsKey(id, url)
      ? 'local'
      : form.encryptionAvailable
        ? 'none'
        : 'unavailable'
  // Without OS secure storage a provider with no base URL has nothing to open.
  const manageable = form.encryptionAvailable || id === 'ollama' || id === 'custom'

  return (
    <div data-settings-field={id === 'custom' ? 'custom-url' : id === 'ollama' ? 'ollama-url' : undefined}>
      <div className="flex h-11 items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface text-fg-strong">
          <ProviderLogo id={id} size={14} tone="current" />
        </span>
        <span className="min-w-0 truncate text-sm text-fg">{label}</span>
        {url ? (
          <span className="min-w-0 truncate font-mono text-caption text-tertiary" title={url}>
            {hostPreview(url)}
          </span>
        ) : null}
        <span className="flex-1" />
        {inUse ? <span className="shrink-0 text-caption font-medium text-accent">In use</span> : null}
        <KeyStatus state={state} />
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={state === 'none' ? `Add key for ${label}` : `Manage ${label}`}
          disabled={form.formLocked || !manageable}
          onClick={() => form.toggleKeyProvider(id)}
        >
          {state === 'none' ? 'Add key' : 'Manage'}
        </Button>
      </div>
      {id === 'custom' &&
      inUse &&
      saved &&
      normalizeCustomOpenAiBaseUrl(form.customUrl) === CUSTOM_OPENAI_DEFAULT ? (
        <p className="m-0 -mt-1 flex items-center gap-1.5 pb-3 pl-10 text-xs text-warning" role="status">
          <Icon name="warning" size={13} />
          The base URL is still the local default. A hosted provider needs its own endpoint.
        </p>
      ) : null}
      {open ? (
        <div id={panelId} className="-mt-1 flex flex-col gap-2 pb-3 pl-10">
          {id === 'custom' ? (
            <BaseUrlField
              inputId="custom-openai-url"
              ariaLabel="Custom OpenAI base URL"
              hint="An OpenAI-compatible base ending in /v1 or a vendor's mount, such as https://api.deepinfra.com/v1/openai. Public hosts need a key; loopback and a private LAN can go without."
              value={form.customUrl}
              disabled={form.formLocked}
              invalid={form.errorField === 'customUrl'}
              describedBy={form.errorField === 'customUrl' ? 'custom-url-error' : undefined}
              error={form.fieldError.customUrl}
              onChange={form.setCustomUrl}
              onCommit={() => {
                void form.commitCustomUrl()
              }}
            />
          ) : null}
          {id === 'ollama' ? (
            <BaseUrlField
              inputId="ollama"
              ariaLabel="Ollama base URL"
              hint="The local daemon by default. Saving an API key moves this to Ollama Cloud (https://ollama.com); a local host never needs one."
              value={form.ollamaUrl}
              disabled={form.formLocked}
              invalid={form.errorField === 'ollama'}
              describedBy={form.errorField === 'ollama' ? 'ollama-error' : undefined}
              error={form.fieldError.ollama}
              onChange={form.setOllamaUrl}
              onCommit={() => {
                void form.commitOllamaUrl()
              }}
            />
          ) : null}
          {id === 'opencode' && !saved ? (
            <p className="m-0 text-xs leading-[18px] text-muted">
              OpenCode Go is a $10/month subscription. Subscribe, then paste the API key from its console.{' '}
              <ExternalLink href="https://opencode.ai/go">Subscribe</ExternalLink>
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <Input
                id="apikey"
                size="sm"
                mono
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={`API key (${label})`}
                aria-invalid={form.errorField === 'apikey' ? true : undefined}
                aria-describedby={form.errorField === 'apikey' ? 'apikey-error' : undefined}
                value={form.keyDraft}
                placeholder={
                  !form.encryptionAvailable
                    ? 'Secure storage unavailable'
                    : saved
                      ? '•••••••• (saved)'
                      : `Paste a ${label} API key`
                }
                disabled={!form.encryptionAvailable || form.savingKey || form.clearingKey}
                onChange={(e) => form.setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && form.keyDraft.trim() && !form.savingKey) {
                    e.preventDefault()
                    void form.saveKey()
                  }
                }}
              />
            </span>
            <Button
              size="sm"
              variant="primary"
              pending={form.savingKey}
              disabled={!form.encryptionAvailable || !form.keyDraft.trim() || form.clearingKey}
              onClick={() => {
                void form.saveKey()
              }}
            >
              {form.savingKey ? 'Saving…' : 'Save key'}
            </Button>
            {saved ? (
              <Button
                size="sm"
                variant="ghost"
                pending={form.clearingKey}
                disabled={form.savingKey}
                onClick={onClearKey}
              >
                {form.clearingKey ? 'Clearing…' : 'Clear'}
              </Button>
            ) : PROVIDER_KEY_URLS[id] ? (
              <ExternalLink href={PROVIDER_KEY_URLS[id]!}>Get a key</ExternalLink>
            ) : null}
          </div>
          {form.errorField === 'apikey' && form.displayError ? (
            <p id="apikey-error" className="m-0 text-xs text-danger" role="alert">
              {form.displayError}
            </p>
          ) : null}
          {!inUse && state !== 'none' && state !== 'unavailable' ? (
            <div>
              <Button
                size="xs"
                variant="ghost"
                disabled={form.formLocked}
                onClick={() => {
                  void form.setActiveProvider(id)
                }}
              >
                Use for new tasks
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function KeyStatus({ state }: { state: KeyState }) {
  switch (state) {
    case 'saved':
      return <span className="shrink-0 text-xs text-muted">Key saved</span>
    case 'local':
      return <span className="shrink-0 text-xs text-muted">Local · no key needed</span>
    case 'none':
      return <span className="shrink-0 text-xs text-tertiary">No key</span>
    case 'unavailable':
      return <span className="shrink-0 text-xs text-tertiary">Can’t save keys</span>
  }
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
      onClick={() => {
        void window.vyotiq?.shellOpenExternal(href)
      }}
    >
      {children}
      <Icon name="external" size={11} />
    </button>
  )
}

function BaseUrlField({
  inputId,
  ariaLabel,
  hint,
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
  hint: string
  value: string
  disabled: boolean
  invalid: boolean
  describedBy?: string
  error: ReactNode
  onChange: (value: string) => void
  onCommit: () => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <Input
        id={inputId}
        size="sm"
        mono
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <p className="m-0 text-xs leading-[18px] text-muted">{hint}</p>
      {error}
    </div>
  )
}

/** Host (and a vendor path, when there is one) of a base URL, for the row. */
function hostPreview(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
    const path = parsed.pathname.replace(/\/+$/, '')
    if (path && path !== '/' && !/^\/v1$/i.test(path)) return `${parsed.host}${path}`
    return parsed.host
  } catch {
    return trimmed
  }
}
