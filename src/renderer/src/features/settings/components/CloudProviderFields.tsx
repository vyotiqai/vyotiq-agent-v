import { useEffect, useState, type ReactNode } from 'react'
import type { GoogleAdcStatus } from '@shared/domain/network'
import {
  BEDROCK_REGION_RE,
  VERTEX_ADC_MARKER,
  VERTEX_LOCATION_RE,
  VERTEX_PROJECT_RE
} from '@shared/domain/cloudProviders'
import { Button, Input, Segmented, Textarea } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'

/** One labelled text field that saves on blur, with its error under it. */
function CommitField({
  label,
  hint,
  value,
  placeholder,
  disabled,
  validate,
  onCommit
}: {
  label: string
  hint: ReactNode
  value: string
  placeholder: string
  disabled: boolean
  /** Why the draft can't be saved, or null. */
  validate: (draft: string) => string | null
  onCommit: (draft: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const errorId = `${label.toLowerCase().replace(/\W+/g, '-')}-error`
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const next = draft.trim()
    if (next === value) {
      setError(null)
      return
    }
    const why = validate(next)
    setError(why)
    if (!why) onCommit(next)
  }
  return (
    <div className="flex flex-col gap-1">
      <Input
        size="sm"
        mono
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <p className="m-0 text-xs leading-[18px] text-muted">{hint}</p>
      {error ? (
        <p id={errorId} className="m-0 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Amazon Bedrock: the region its calls go to, and how they're signed — a
 * Bedrock API key, or an IAM access key pair (saved together as one secret).
 */
export function BedrockFields({
  form,
  saved,
  keyInput
}: {
  form: SettingsFormState
  saved: boolean
  /** The shared key field, for the API key way in. */
  keyInput: (placeholder: string) => ReactNode
}) {
  const [mode, setMode] = useState<'apiKey' | 'keys'>('apiKey')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const region = form.settings.bedrockRegion

  const saveKeys = (): void => {
    void form
      .saveKey(
        JSON.stringify({
          accessKeyId: accessKeyId.trim(),
          secretAccessKey: secretKey.trim(),
          ...(sessionToken.trim() ? { sessionToken: sessionToken.trim() } : {})
        })
      )
      .then(() => {
        setAccessKeyId('')
        setSecretKey('')
        setSessionToken('')
      })
  }

  return (
    <>
      <CommitField
        label="AWS region"
        hint={`Calls go only to bedrock-runtime.${region}.amazonaws.com.`}
        value={region}
        placeholder="us-east-1"
        disabled={form.formLocked}
        validate={(draft) => (BEDROCK_REGION_RE.test(draft) ? null : 'Use a region code, like us-east-1 or eu-central-1.')}
        onCommit={(bedrockRegion) => {
          void form.runUpdate({ bedrockRegion })
        }}
      />
      <div>
        <Segmented
          label="Bedrock sign-in"
          value={mode}
          items={[
            { id: 'apiKey', label: 'API key' },
            { id: 'keys', label: 'Access keys' }
          ]}
          onChange={setMode}
        />
      </div>
      {mode === 'apiKey' ? (
        keyInput(saved ? '•••••••• (saved)' : 'Paste a Bedrock API key')
      ) : (
        <div className="flex flex-col gap-2">
          <Input
            size="sm"
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="AWS access key ID"
            placeholder="Access key ID (AKIA…)"
            value={accessKeyId}
            disabled={!form.encryptionAvailable || form.savingKey}
            onChange={(e) => setAccessKeyId(e.target.value)}
          />
          <Input
            size="sm"
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="AWS secret access key"
            placeholder="Secret access key"
            value={secretKey}
            disabled={!form.encryptionAvailable || form.savingKey}
            onChange={(e) => setSecretKey(e.target.value)}
          />
          <Input
            size="sm"
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="AWS session token"
            placeholder="Session token (temporary keys only)"
            value={sessionToken}
            disabled={!form.encryptionAvailable || form.savingKey}
            onChange={(e) => setSessionToken(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              pending={form.savingKey}
              disabled={!form.encryptionAvailable || !accessKeyId.trim() || !secretKey.trim()}
              onClick={saveKeys}
            >
              {form.savingKey ? 'Saving…' : 'Save keys'}
            </Button>
            {saved ? <span className="text-xs text-muted">Saving replaces the key in use.</span> : null}
          </div>
        </div>
      )}
    </>
  )
}

/** What a pasted service-account key is missing, or null when it looks usable. */
function serviceAccountError(raw: string): string | null {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return 'That is not JSON. Paste the whole key file.'
  }
  if (json.type !== 'service_account') return 'This is not a service-account key file.'
  if (typeof json.client_email !== 'string' || typeof json.private_key !== 'string') {
    return 'The key file is missing client_email or private_key.'
  }
  return null
}

/**
 * Google Vertex AI: the project and location it bills, and how to sign in —
 * a service-account key file, or this computer's gcloud login.
 */
export function VertexFields({ form }: { form: SettingsFormState }) {
  const [mode, setMode] = useState<'file' | 'gcloud'>('file')
  const [keyFile, setKeyFile] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [adc, setAdc] = useState<GoogleAdcStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const project = form.settings.vertexProject
  const projectSet = VERTEX_PROJECT_RE.test(project)

  const checkAdc = (): void => {
    setChecking(true)
    void window.vyotiq
      .googleAdcStatus()
      .then((res) => setAdc(res.ok ? res.data : { found: false, path: '', error: res.error }))
      .finally(() => setChecking(false))
  }

  return (
    <>
      <CommitField
        label="Google Cloud project"
        hint="The project ID Vertex AI bills, like my-project-123."
        value={project}
        placeholder="my-project-123"
        disabled={form.formLocked}
        validate={(draft) => (VERTEX_PROJECT_RE.test(draft) ? null : 'Use the project ID (6–30 lowercase letters, digits and hyphens).')}
        onCommit={(vertexProject) => {
          void form.runUpdate({ vertexProject })
        }}
      />
      <CommitField
        label="Vertex location"
        hint="global for the widest choice of models; us, eu or a region like us-east5 to keep data there."
        value={form.settings.vertexLocation}
        placeholder="global"
        disabled={form.formLocked}
        validate={(draft) => (VERTEX_LOCATION_RE.test(draft) ? null : 'Use global, us, eu, or a region like us-east5.')}
        onCommit={(vertexLocation) => {
          void form.runUpdate({ vertexLocation })
        }}
      />
      <div>
        <Segmented
          label="Vertex sign-in"
          value={mode}
          items={[
            { id: 'file', label: 'Key file' },
            { id: 'gcloud', label: 'gcloud login' }
          ]}
          onChange={setMode}
        />
      </div>
      {!projectSet ? <p className="m-0 text-xs text-muted">Set the project first.</p> : null}
      {mode === 'file' ? (
        <div className="flex flex-col gap-2">
          <Textarea
            size="sm"
            mono
            rows={4}
            spellCheck={false}
            aria-label="Service account key (JSON)"
            aria-invalid={keyError ? true : undefined}
            aria-describedby={keyError ? 'vertex-key-error' : undefined}
            placeholder={'{ "type": "service_account", … }'}
            value={keyFile}
            disabled={!form.encryptionAvailable || form.savingKey}
            onChange={(e) => setKeyFile(e.target.value)}
          />
          {keyError ? (
            <p id="vertex-key-error" className="m-0 text-xs text-danger" role="alert">
              {keyError}
            </p>
          ) : null}
          <div>
            <Button
              size="sm"
              variant="primary"
              pending={form.savingKey}
              disabled={!form.encryptionAvailable || !projectSet || !keyFile.trim()}
              onClick={() => {
                const why = serviceAccountError(keyFile)
                setKeyError(why)
                if (!why) void form.saveKey(keyFile).then(() => setKeyFile(''))
              }}
            >
              {form.savingKey ? 'Saving…' : 'Save key'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-xs leading-[18px] text-muted">
            Uses the login from <span className="font-mono">gcloud auth application-default login</span>. Nothing is copied; it is read when a
            task starts.
          </p>
          {adc ? (
            adc.found ? (
              <p className="m-0 text-xs text-fg" data-adc="found">
                Found {adc.kind === 'service_account' ? `service account ${adc.account ?? ''}` : 'a gcloud login'} in{' '}
                <span className="font-mono text-muted">{adc.path}</span>
              </p>
            ) : (
              <p className="m-0 text-xs text-danger" role="alert" data-adc="missing">
                {adc.error}
              </p>
            )
          ) : null}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" pending={checking} onClick={checkAdc}>
              {checking ? 'Checking…' : 'Check this computer'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              pending={form.savingKey}
              disabled={!form.encryptionAvailable || !projectSet || !adc?.found}
              onClick={() => {
                void form.saveKey(VERTEX_ADC_MARKER)
              }}
            >
              Use this login
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
