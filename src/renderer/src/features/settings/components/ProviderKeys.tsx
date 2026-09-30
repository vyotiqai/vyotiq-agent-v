import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  isCustomProviderId,
  type CustomProvider,
  type SecretProvider
} from '@shared/ipc'
import {
  CUSTOM_OPENAI_DEFAULT,
  normalizeCustomOpenAiBaseUrl,
  providerLabel,
  providerNeedsKey
} from '@shared/providers'
import { Icon } from '@renderer/lib/icons'
import { Button, Input, Segmented, Textarea, pushToast } from '@renderer/lib/ui'
import { MAX_CUSTOM_HEADERS, customHeaderError } from '@shared/domain/network'
import { BedrockFields, VertexFields } from './CloudProviderFields'
import { ProviderLogo } from '@renderer/features/chat/components/composer/ProviderLogo'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { PROVIDER_KEY_URLS } from '../constants'

const ENDPOINT_URL_HINT =
  "An OpenAI-compatible base ending in /v1 or a vendor's mount. Public hosts need a key; loopback and a private LAN can go without."
const AZURE_URL_HINT =
  'The resource endpoint from the Azure portal, like https://my-resource.openai.azure.com. It is used through Azure’s v1 API.'

type EndpointKind = NonNullable<CustomProvider['kind']>

type KeyState = 'saved' | 'local' | 'none' | 'unavailable'

/**
 * Every provider in `ids` as one row: its mark, whether it is the one new
 * tasks use, and whether it has a key. One row opens at a time, for its key
 * and — for Ollama, Custom and user-added endpoints — its base URL.
 */
export function ProviderKeys({
  ids,
  form,
  secrets,
  onClearKey
}: {
  ids: readonly SecretProvider[]
  form: SettingsFormState
  secrets: Record<SecretProvider, boolean>
  onClearKey: () => void
}) {
  return (
    <>
      {ids.map((id) => {
        const endpoint = isCustomProviderId(id)
          ? form.customProviders.find((entry) => entry.id === id)
          : undefined
        // An id whose endpoint is gone has nothing left to manage.
        if (isCustomProviderId(id) && !endpoint) return null
        return (
          <ProviderKeyRow
            key={id}
            id={id}
            endpoint={endpoint}
            form={form}
            saved={Boolean(secrets[id])}
            onClearKey={onClearKey}
          />
        )
      })}
    </>
  )
}

function ProviderKeyRow({
  id,
  endpoint,
  form,
  saved,
  onClearKey
}: {
  id: SecretProvider
  /** Set for a user-added `custom:<slug>` endpoint. */
  endpoint?: CustomProvider
  form: SettingsFormState
  saved: boolean
  onClearKey: () => void
}) {
  const panelId = useId()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const label = providerLabel(id, form.customProviders)
  const open = form.openKeyProvider === id
  const inUse = id === form.settings.provider
  const hasBaseUrl = id === 'ollama' || id === 'custom' || endpoint !== undefined
  const url = endpoint
    ? endpoint.baseUrl
    : id === 'ollama'
      ? form.ollamaUrl
      : id === 'custom'
        ? form.customUrl
        : ''
  const state: KeyState = saved
    ? 'saved'
    : hasBaseUrl && !providerNeedsKey(id, url)
      ? 'local'
      : form.encryptionAvailable
        ? 'none'
        : 'unavailable'
  // Without OS secure storage a provider with no base URL has nothing to open.
  const manageable = form.encryptionAvailable || hasBaseUrl
  // Bedrock and Vertex sign in more ways than a pasted key; their panels clear it themselves.
  const cloud = id === 'bedrock' || id === 'vertex'
  const detail =
    id === 'bedrock'
      ? form.settings.bedrockRegion
      : id === 'vertex'
        ? form.settings.vertexProject
          ? `${form.settings.vertexProject} · ${form.settings.vertexLocation}`
          : ''
        : url
          ? hostPreview(url)
          : ''

  const keyInput = (placeholder: string): ReactNode => (
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
          placeholder={!form.encryptionAvailable ? 'Secure storage unavailable' : placeholder}
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
      {cloud ? null : saved ? (
        <Button size="sm" variant="ghost" pending={form.clearingKey} disabled={form.savingKey} onClick={onClearKey}>
          {form.clearingKey ? 'Clearing…' : 'Clear'}
        </Button>
      ) : PROVIDER_KEY_URLS[id] ? (
        <ExternalLink href={PROVIDER_KEY_URLS[id]!}>Get a key</ExternalLink>
      ) : null}
    </div>
  )

  return (
    <div data-settings-field={id === 'custom' ? 'custom-url' : id === 'ollama' ? 'ollama-url' : undefined}>
      <div className="flex h-11 items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface text-fg-strong">
          <ProviderLogo id={id} size={14} tone="current" />
        </span>
        <span className="min-w-0 truncate text-sm text-fg">{label}</span>
        {detail ? (
          <span className="min-w-0 truncate font-mono text-caption text-tertiary" title={url || detail}>
            {detail}
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
          onClick={() => {
            setConfirmRemove(false)
            form.toggleKeyProvider(id)
          }}
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
          {endpoint ? (
            <EndpointFields key={endpoint.id} endpoint={endpoint} form={form} />
          ) : null}
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
          {endpoint?.kind === 'azure' && !saved ? (
            <p className="m-0 text-xs leading-[18px] text-muted">
              Paste one of the resource’s keys. Pick models by their deployment names.
            </p>
          ) : null}
          {id === 'bedrock' ? (
            <BedrockFields form={form} saved={saved} keyInput={keyInput} />
          ) : id === 'vertex' ? (
            <VertexFields form={form} />
          ) : (
            keyInput(
              saved
                ? '•••••••• (saved)'
                : endpoint?.kind === 'azure'
                  ? 'Paste a key for this resource'
                  : `Paste a ${label} API key`
            )
          )}
          {saved && (id === 'bedrock' || id === 'vertex') ? (
            <div>
              <Button size="xs" variant="ghost" pending={form.clearingKey} disabled={form.savingKey} onClick={onClearKey}>
                {form.clearingKey ? 'Clearing…' : 'Sign out'}
              </Button>
            </div>
          ) : null}
          {form.errorField === 'apikey' && form.displayError ? (
            <p id="apikey-error" className="m-0 text-xs text-danger" role="alert">
              {form.displayError}
            </p>
          ) : null}
          {endpoint && confirmRemove ? (
            <div className="flex items-center gap-2" role="group" aria-label={`Remove ${endpoint.name}`}>
              <span className="min-w-0 flex-1 text-xs text-fg">
                Remove {endpoint.name}
                {saved ? ' and its saved key' : ''}?
              </span>
              <Button size="xs" variant="ghost" disabled={removing} onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
              <Button
                size="xs"
                variant="danger"
                pending={removing}
                onClick={() => {
                  setRemoving(true)
                  void form.removeEndpoint(endpoint.id).finally(() => {
                    setRemoving(false)
                    setConfirmRemove(false)
                  })
                }}
              >
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            </div>
          ) : (!inUse && state !== 'none' && state !== 'unavailable') || endpoint ? (
            <div className="flex items-center gap-2">
              {!inUse && state !== 'none' && state !== 'unavailable' ? (
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
              ) : null}
              {endpoint ? (
                // Trailing edge; the wrapper carries ml-auto because a
                // disabled Button renders inside its tooltip span.
                <span className="ml-auto inline-flex">
                  <Button
                    size="xs"
                    variant="ghost"
                    icon="trash"
                    disabled={form.formLocked || inUse}
                    title={inUse ? 'Switch the provider for new tasks to remove it.' : undefined}
                    onClick={() => setConfirmRemove(true)}
                  >
                    Remove
                  </Button>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Name and base URL of a user-added endpoint. Drafts stay local and save on
 * blur, so a half-typed URL never reaches settings; the error sits under the
 * field that caused it.
 */
function EndpointFields({ endpoint, form }: { endpoint: CustomProvider; form: SettingsFormState }) {
  const [name, setName] = useState(endpoint.name)
  const [url, setUrl] = useState(endpoint.baseUrl)
  const [nameError, setNameError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)

  const commitName = (): void => {
    if (name.trim() === endpoint.name) {
      setNameError(null)
      return
    }
    const error = form.endpointFieldError({ name }, endpoint.id)
    setNameError(error)
    if (!error) void form.updateEndpoint(endpoint.id, { name })
  }
  const commitUrl = (): void => {
    if (url.trim() === endpoint.baseUrl) {
      setUrlError(null)
      return
    }
    const error = form.endpointFieldError({ baseUrl: url, kind: endpoint.kind }, endpoint.id)
    setUrlError(error)
    if (!error) void form.updateEndpoint(endpoint.id, { baseUrl: url })
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <Input
          id="endpoint-name"
          size="sm"
          aria-label="Endpoint name"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'endpoint-name-error' : undefined}
          disabled={form.formLocked}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        {nameError ? (
          <p id="endpoint-name-error" className="m-0 text-xs text-danger" role="alert">
            {nameError}
          </p>
        ) : null}
      </div>
      <BaseUrlField
        inputId="endpoint-url"
        ariaLabel="Endpoint base URL"
        hint={endpoint.kind === 'azure' ? AZURE_URL_HINT : ENDPOINT_URL_HINT}
        value={url}
        disabled={form.formLocked}
        invalid={Boolean(urlError)}
        describedBy={urlError ? 'endpoint-url-error' : undefined}
        error={
          urlError ? (
            <p id="endpoint-url-error" className="m-0 text-xs text-danger" role="alert">
              {urlError}
            </p>
          ) : null
        }
        onChange={setUrl}
        onCommit={commitUrl}
      />
      <EndpointHeadersField endpoint={endpoint} form={form} />
    </>
  )
}

/** `Name: value` lines ↔ a header map. */
function headersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/** Parse `Name: value` lines, or say which line is wrong. */
export function parseHeaderLines(text: string): { headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon <= 0) return { error: `Line ${i + 1} needs the form Name: value.` }
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    const why = customHeaderError(name, value)
    if (why) return { error: `Line ${i + 1}: ${why}` }
    if (Object.keys(headers).some((n) => n.toLowerCase() === name.toLowerCase())) {
      return { error: `Line ${i + 1}: ${name} is already set above.` }
    }
    headers[name] = value
  }
  if (Object.keys(headers).length > MAX_CUSTOM_HEADERS) return { error: `Keep it to ${MAX_CUSTOM_HEADERS} headers.` }
  return { headers }
}

/**
 * Extra headers an endpoint's gateway wants (a routing key, an org id). They
 * live in settings, not the key vault, so the hint steers secrets to the key.
 */
function EndpointHeadersField({ endpoint, form }: { endpoint: CustomProvider; form: SettingsFormState }) {
  const [text, setText] = useState(() => headersToText(endpoint.headers))
  const [error, setError] = useState<string | null>(null)
  const commit = (): void => {
    const parsed = parseHeaderLines(text)
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    setError(null)
    void form.updateEndpoint(endpoint.id, { headers: parsed.headers })
  }
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        size="sm"
        mono
        rows={2}
        spellCheck={false}
        aria-label="Extra headers"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'endpoint-headers-error' : undefined}
        placeholder="X-Header: value"
        disabled={form.formLocked}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
      <p className="m-0 text-xs leading-[18px] text-muted">
        Extra headers, one Name: value per line. Stored in settings, not the key vault — put secrets in the API key.
      </p>
      {error ? (
        <p id="endpoint-headers-error" className="m-0 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The last row of the endpoint list: opens a name + base URL form. Adding
 * opens the new endpoint's row, so its key can be pasted next.
 */
export function AddEndpointRow({ form, max }: { form: SettingsFormState; max: number }) {
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState<EndpointKind>('openai')
  const [nameError, setNameError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const count = form.customProviders.length

  // Opening the form is an explicit click, so the name field takes focus.
  useEffect(() => {
    if (open) nameRef.current?.focus()
  }, [open])

  const reset = (): void => {
    setOpen(false)
    setName('')
    setUrl('')
    setKind('openai')
    setNameError(null)
    setUrlError(null)
  }

  const submit = async (): Promise<void> => {
    const nextNameError = form.endpointFieldError({ name })
    const nextUrlError = form.endpointFieldError({ baseUrl: url, kind })
    setNameError(nextNameError)
    setUrlError(nextUrlError)
    if (nextNameError || nextUrlError) return
    setAdding(true)
    const ok = await form.addEndpoint(name, url, kind)
    setAdding(false)
    if (ok) reset()
  }

  if (count >= max) {
    return <p className="m-0 flex h-11 items-center pl-10 text-xs text-muted">{`${count} of ${max} endpoints saved`}</p>
  }

  return (
    <div>
      <button
        type="button"
        className="flex h-11 w-full items-center gap-3 rounded-md text-left text-sm text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring disabled:vy-disabled-state"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={form.formLocked}
        onClick={() => (open ? reset() : setOpen(true))}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface">
          <Icon name="plus" size={14} />
        </span>
        Add endpoint
      </button>
      {open ? (
        <form
          id={panelId}
          className="-mt-1 flex flex-col gap-2 pb-3 pl-10"
          aria-label="Add endpoint"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div>
            <Segmented
              label="Endpoint kind"
              value={kind}
              items={[
                { id: 'openai', label: 'OpenAI-compatible' },
                { id: 'azure', label: 'Azure OpenAI' }
              ]}
              disabled={adding}
              onChange={(next) => {
                setKind(next)
                setUrlError(null)
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Input
              ref={nameRef}
              id="new-endpoint-name"
              size="sm"
              aria-label="New endpoint name"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? 'new-endpoint-name-error' : undefined}
              placeholder="Name, such as Home GPU"
              maxLength={60}
              value={name}
              disabled={adding}
              onChange={(e) => setName(e.target.value)}
            />
            {nameError ? (
              <p id="new-endpoint-name-error" className="m-0 text-xs text-danger" role="alert">
                {nameError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Input
              id="new-endpoint-url"
              size="sm"
              mono
              aria-label="New endpoint base URL"
              aria-invalid={urlError ? true : undefined}
              aria-describedby={urlError ? 'new-endpoint-url-error' : undefined}
              placeholder={kind === 'azure' ? 'https://my-resource.openai.azure.com' : 'http://localhost:1234/v1'}
              spellCheck={false}
              value={url}
              disabled={adding}
              onChange={(e) => setUrl(e.target.value)}
            />
            {urlError ? (
              <p id="new-endpoint-url-error" className="m-0 text-xs text-danger" role="alert">
                {urlError}
              </p>
            ) : null}
            <p className="m-0 text-xs leading-[18px] text-muted">{kind === 'azure' ? AZURE_URL_HINT : ENDPOINT_URL_HINT}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" variant="primary" pending={adding} disabled={form.formLocked}>
              {adding ? 'Adding…' : 'Add'}
            </Button>
            <Button size="sm" variant="ghost" disabled={adding} onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
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
        // A link that could not open says so, rather than doing nothing.
        void window.vyotiq
          ?.shellOpenExternal(href)
          .then((res) => {
            if (!res.ok) pushToast(`Couldn’t open ${href}: ${res.error}`, 'error')
          })
          .catch((err: unknown) => pushToast(`Couldn’t open ${href}: ${err instanceof Error ? err.message : String(err)}`, 'error'))
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
