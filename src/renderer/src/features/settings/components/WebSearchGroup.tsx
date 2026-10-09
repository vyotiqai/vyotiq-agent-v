import { useEffect, useState, type JSX } from 'react'
import { DEFAULT_WEB_SEARCH, type WebSearchProvider } from '@shared/ipc'
import { Button, Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsOption } from '../types'
import { SelectField } from './SelectField'
import { SettingsField, SettingsGroup } from './SettingsField'

const ENGINE_OPTIONS: SettingsOption<WebSearchProvider>[] = [
  { value: 'duckduckgo', label: 'DuckDuckGo (no key)' },
  { value: 'brave', label: 'Brave Search API' },
  { value: 'tavily', label: 'Tavily API' },
  { value: 'searxng', label: 'SearXNG (your own)' }
]

type KeyedEngine = 'brave' | 'tavily'

/**
 * Where the agent's web_search asks. DuckDuckGo's HTML page needs nothing but
 * may ask for a check now and then; an API key or your own SearXNG answers
 * every time. Keys go to the key vault, like model keys, never settings.json.
 */
export function WebSearchGroup({ form }: { form: SettingsFormState }): JSX.Element {
  const web = form.settings.webSearch ?? DEFAULT_WEB_SEARCH
  const keyed: KeyedEngine | null = web.provider === 'brave' || web.provider === 'tavily' ? web.provider : null
  const [saved, setSaved] = useState<Record<KeyedEngine, boolean>>({ brave: false, tavily: false })
  const [draft, setDraft] = useState('')
  const [urlDraft, setUrlDraft] = useState(web.searxngUrl)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setUrlDraft(web.searxngUrl), [web.searxngUrl])
  useEffect(() => {
    void window.vyotiq?.toolSecretStatus?.().then((res) => {
      if (res?.ok) setSaved(res.data)
    })
  }, [])

  const saveKey = async (): Promise<void> => {
    if (!keyed || !draft.trim()) return
    const res = await window.vyotiq.toolSecretSet({ name: keyed, key: draft.trim() })
    if (!res.ok) {
      setError(res.error)
      return
    }
    setSaved(res.data)
    setDraft('')
    setError(null)
  }
  const clearKey = async (): Promise<void> => {
    if (!keyed) return
    const res = await window.vyotiq.toolSecretClear({ name: keyed })
    if (res.ok) setSaved(res.data)
  }

  return (
    <SettingsGroup title="Web search">
      <SelectField
        id="web-search-engine"
        title="web_search asks"
        hint="Titles, links and snippets for the agent, without opening the browser."
        help="DuckDuckGo needs no key but can ask for a check the agent cannot pass; then it falls back to the browser. Brave and Tavily need an API key; SearXNG is an instance you run."
        value={web.provider}
        options={ENGINE_OPTIONS}
        width={200}
        disabled={form.formLocked}
        onChange={(provider) => {
          setError(null)
          void form.runUpdate({ webSearch: { ...web, provider } })
        }}
        {...form.defaultMark('webSearch')}
      />
      {keyed ? (
        <SettingsField
          id="web-search-key"
          title={keyed === 'brave' ? 'Brave Search key' : 'Tavily key'}
          hint={saved[keyed] ? 'Saved in the key vault.' : 'Not set yet.'}
          nested
          below={
            error ? (
              <p role="alert" className="m-0 text-xs text-danger">
                {error}
              </p>
            ) : undefined
          }
        >
          <div className="flex items-center gap-1.5">
            {/* Width from the wrapper: Input is w-full and cn() has no merge. */}
            <div className="w-56">
              <Input
                size="sm"
                type="password"
                autoComplete="off"
                aria-label={keyed === 'brave' ? 'Brave Search API key' : 'Tavily API key'}
                placeholder={saved[keyed] ? 'Replace the key' : 'Paste the key'}
                value={draft}
                disabled={form.formLocked}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveKey()
                }}
              />
            </div>
            <Button size="sm" disabled={form.formLocked || !draft.trim()} onClick={() => void saveKey()}>
              Save
            </Button>
            {saved[keyed] ? (
              <Button size="sm" variant="ghost" disabled={form.formLocked} onClick={() => void clearKey()}>
                Remove
              </Button>
            ) : null}
          </div>
        </SettingsField>
      ) : null}
      {web.provider === 'searxng' ? (
        <SettingsField id="web-search-searxng" title="SearXNG address" hint="Its JSON output must be on." nested>
          <div className="w-64">
            <Input
              size="sm"
              aria-label="SearXNG address"
              placeholder="http://localhost:8888"
              className="font-mono"
              value={urlDraft}
              disabled={form.formLocked}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => {
                const next = urlDraft.trim()
                if (next !== web.searxngUrl) void form.runUpdate({ webSearch: { ...web, searxngUrl: next } })
              }}
            />
          </div>
        </SettingsField>
      ) : null}
    </SettingsGroup>
  )
}
