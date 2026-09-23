import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import {
  SEARCH_ENGINE_OPTIONS,
  TERMINAL_SCREEN_READER_OPTIONS,
  TERMINAL_SHELL_OPTIONS
} from '../constants'
import { AutoTextarea } from '../components/AutoTextarea'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'
import { ToolCatalogCard } from '../components/ToolCatalogCard'
import {
  formatBrowserDomainAllowlist,
  parseBrowserDomainAllowlist
} from '../utils/settingsHelpers'

/**
 * Text settings that save on blur keep a local draft; closing Settings with
 * the field still focused must not drop what was typed.
 */
function useFlushOnUnmount(flush: () => void): void {
  const ref = useRef(flush)
  ref.current = flush
  useEffect(() => () => ref.current(), [])
}

export function ToolsSection({
  form,
  onOpenMarketplace
}: {
  form: SettingsFormState
  onOpenMarketplace?: SettingsViewProps['onOpenMarketplace']
}) {
  const settings = form.settings

  const persistedAllowlist = settings.browserDomainAllowlist ?? []
  const allowlistKey = persistedAllowlist.join('\n')
  const [allowlistDraft, setAllowlistDraft] = useState(() =>
    formatBrowserDomainAllowlist(persistedAllowlist)
  )
  useEffect(() => {
    setAllowlistDraft(allowlistKey)
  }, [allowlistKey])
  const commitAllowlist = (): void => {
    const next = parseBrowserDomainAllowlist(allowlistDraft)
    if (next.join('\n') === allowlistKey) return
    void form.runUpdate({ browserDomainAllowlist: next })
  }
  useFlushOnUnmount(commitAllowlist)

  const persistedDiagnostics = settings.diagnosticsCommand ?? ''
  const [diagnosticsDraft, setDiagnosticsDraft] = useState(persistedDiagnostics)
  useEffect(() => {
    setDiagnosticsDraft(persistedDiagnostics)
  }, [persistedDiagnostics])
  const commitDiagnostics = (): void => {
    const next = diagnosticsDraft.trim()
    if (next === persistedDiagnostics) return
    void form.runUpdate({ diagnosticsCommand: next })
  }
  useFlushOnUnmount(commitDiagnostics)

  return (
    <SettingsStack>
      <SettingsGroup title="Terminal">
        <SelectField
          id="terminal-shell"
          title="Terminal shell"
          hint="Shell for the agent's terminal and the terminal panel."
          help="Auto uses PowerShell on Windows when it is available."
          value={settings.terminalShell ?? 'auto'}
          options={TERMINAL_SHELL_OPTIONS}
          disabled={form.formLocked}
          onChange={(terminalShell) => {
            void form.runUpdate({ terminalShell })
          }}
        />
        <SettingsField
          id="diagnostics-command"
          title="Diagnostics command"
          hint="What the agent runs to check its work."
          help="Runs for both typecheck and lint. Leave blank to use the project's typecheck and lint scripts, falling back to tsc and eslint."
        >
          {/* Sized by the wrapper; Input's own `w-full` would beat a width
              passed through className (no tailwind-merge). */}
          <div className="w-full sm:w-64">
            <Input
              className="font-mono"
              placeholder="Auto-detect"
              aria-label="Diagnostics command"
              spellCheck={false}
              disabled={form.formLocked}
              value={diagnosticsDraft}
              onChange={(e) => setDiagnosticsDraft(e.target.value)}
              onBlur={commitDiagnostics}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
            />
          </div>
        </SettingsField>
        <SelectField
          id="terminal-screen-reader"
          title="Screen reader mode"
          label="Terminal screen reader"
          hint="Accessible terminal output for assistive technology."
          help="Auto turns it on only when a screen reader is detected. Always on costs CPU on fast output, because xterm keeps a parallel accessibility DOM for every chunk."
          value={settings.terminalScreenReader ?? 'auto'}
          options={TERMINAL_SCREEN_READER_OPTIONS}
          disabled={form.formLocked}
          onChange={(terminalScreenReader) => {
            void form.runUpdate({ terminalScreenReader })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Browser">
        <SelectField
          id="search-engine"
          title="Search engine"
          hint="Used when the agent searches from its browser."
          value={settings.searchEngine}
          options={SEARCH_ENGINE_OPTIONS}
          disabled={form.formLocked}
          onChange={(searchEngine) => {
            void form.runUpdate({ searchEngine })
          }}
        />
        <SettingsField
          id="browser-domain-allowlist"
          title="Domain allowlist"
          hint={
            persistedAllowlist.length > 0
              ? `Only these ${persistedAllowlist.length === 1 ? 'host is' : `${persistedAllowlist.length} hosts are`} allowed. Clear the list to allow any site.`
              : 'Empty: the agent’s browser may open any site.'
          }
          help="One hostname per line, or comma-separated. Exact (example.com) or wildcard (*.example.com), case-insensitive; a pasted URL keeps its host. Checked on every navigation and redirect."
          wide
        >
          <AutoTextarea
            className="font-mono"
            aria-label="Browser domain allowlist"
            placeholder={'example.com\n*.corp.internal'}
            spellCheck={false}
            maxRows={8}
            disabled={form.formLocked}
            value={allowlistDraft}
            onChange={(e) => setAllowlistDraft(e.target.value)}
            onBlur={commitAllowlist}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="MCP">
        <SwitchField
          id="mcp-tool-loading"
          title="Preload every MCP tool"
          hint="Send every connected tool's schema on every step."
          help="Off (the default) sends only tool names; the agent loads a server's schemas when a run needs them. Four connected servers measured 67k tokens a step when preloaded. To keep one server loaded, pin it in Marketplace instead. Takes effect from the next step."
          checked={settings.mcpToolLoading === 'eager'}
          disabled={form.formLocked}
          onChange={(checked) => {
            void form.runUpdate({ mcpToolLoading: checked ? 'eager' : 'on-demand' })
          }}
        />
        <SettingsField
          id="mcp-servers"
          title="MCP servers"
          hint="Connect servers and choose which of their tools the agent gets."
        >
          <Button
            variant="subtle"
            disabled={!onOpenMarketplace}
            onClick={() => onOpenMarketplace?.('mcps')}
          >
            Manage servers
          </Button>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Available tools">
        <SettingsField
          id="tools-catalog"
          title="Live tool catalog"
          hint="What the agent can call right now, and why anything is off."
          help="Built-in tools ship with the app. MCP tools come from connected servers; a server loaded on demand is fully available, its schemas just reach a run only when asked for. Updates live."
          wide
        >
          <ToolCatalogCard />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
