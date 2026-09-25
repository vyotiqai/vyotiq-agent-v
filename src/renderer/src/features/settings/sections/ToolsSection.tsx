import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import {
  SEARCH_ENGINE_OPTIONS,
  TERMINAL_SCREEN_READER_OPTIONS,
  TERMINAL_SHELL_OPTIONS
} from '../constants'
import { AutoTextarea } from '../components/AutoTextarea'
import { SegmentedField } from '../components/SegmentedField'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'
import { ToolCatalog, toolCatalogSummary, useToolCatalog } from '../components/ToolCatalog'
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

/** "Only example.com, *.corp.internal and 2 more." */
function allowlistHint(hosts: readonly string[]): string {
  if (hosts.length === 0) return 'Empty: the agent’s browser may open any site.'
  const named = hosts.slice(0, 2)
  const rest = hosts.length - named.length
  if (rest === 0) return `Only ${named.join(' and ')}.`
  return `Only ${named.join(', ')} and ${rest} more.`
}

export function ToolsSection({
  form,
  onOpenMarketplace
}: {
  form: SettingsFormState
  onOpenMarketplace?: SettingsViewProps['onOpenMarketplace']
}) {
  const settings = form.settings
  const catalog = useToolCatalog()
  const allowlistPanelId = useId()

  const persistedAllowlist = settings.browserDomainAllowlist ?? []
  const allowlistKey = persistedAllowlist.join('\n')
  const [allowlistOpen, setAllowlistOpen] = useState(false)
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
  // Opening the list is asking to edit it: put the caret there.
  useEffect(() => {
    if (!allowlistOpen) return
    document.getElementById(allowlistPanelId)?.querySelector('textarea')?.focus()
  }, [allowlistOpen, allowlistPanelId])

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
          title="Shell"
          label="Terminal shell"
          help="For the agent's terminal and the terminal panel. Auto uses PowerShell on Windows when it is available."
          value={settings.terminalShell ?? 'auto'}
          options={TERMINAL_SHELL_OPTIONS}
          width={140}
          disabled={form.formLocked}
          {...form.defaultMark('terminalShell')}
          onChange={(terminalShell) => {
            void form.runUpdate({ terminalShell })
          }}
        />
        <SettingsField
          id="diagnostics-command"
          title="Diagnostics command"
          hint="What the agent runs to check its work after edits."
          help="Runs for both typecheck and lint. Leave blank to use the project's typecheck and lint scripts, falling back to tsc and eslint."
          {...form.defaultMark('diagnosticsCommand')}
        >
          {/* Sized by the wrapper; Input's own `w-full` would beat a width
              passed through className (no tailwind-merge). */}
          <div className="w-[240px]">
            <Input
              size="sm"
              mono
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
          width={140}
          disabled={form.formLocked}
          {...form.defaultMark('terminalScreenReader')}
          onChange={(terminalScreenReader) => {
            void form.runUpdate({ terminalScreenReader })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Browser">
        <SegmentedField
          id="search-engine"
          title="Search engine"
          value={settings.searchEngine}
          options={SEARCH_ENGINE_OPTIONS}
          disabled={form.formLocked}
          {...form.defaultMark('searchEngine')}
          onChange={(searchEngine) => {
            void form.runUpdate({ searchEngine })
          }}
        />
        <SettingsField
          id="browser-domain-allowlist"
          title="Allowed sites"
          hint={allowlistHint(persistedAllowlist)}
          help="One hostname per line, or comma-separated. Exact (example.com) or wildcard (*.example.com), case-insensitive; a pasted URL keeps its host. Checked on every navigation and redirect."
          {...form.defaultMark('browserDomainAllowlist')}
          below={
            allowlistOpen ? (
              <div id={allowlistPanelId}>
                <AutoTextarea
                  className="font-mono"
                  aria-label="Allowed sites"
                  placeholder={'example.com\n*.corp.internal'}
                  spellCheck={false}
                  maxRows={8}
                  disabled={form.formLocked}
                  value={allowlistDraft}
                  onChange={(e) => setAllowlistDraft(e.target.value)}
                  onBlur={commitAllowlist}
                />
              </div>
            ) : null
          }
        >
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={allowlistOpen}
            aria-controls={allowlistOpen ? allowlistPanelId : undefined}
            onClick={() => setAllowlistOpen((open) => !open)}
          >
            {allowlistOpen ? 'Done' : 'Edit list'}
          </Button>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="MCP">
        <SwitchField
          id="mcp-tool-loading"
          title="Preload every MCP tool"
          hint="Send every connected tool's schema on every step."
          help="Off (the default) sends only tool names; the agent loads a server's schemas when a run needs them. Four connected servers measured 67k tokens a step when preloaded. To keep one server loaded, pin it in Extensions instead. Takes effect from the next step."
          checked={settings.mcpToolLoading === 'eager'}
          disabled={form.formLocked}
          {...form.defaultMark('mcpToolLoading')}
          onChange={(checked) => {
            void form.runUpdate({ mcpToolLoading: checked ? 'eager' : 'on-demand' })
          }}
        />
        <SettingsField
          id="mcp-servers"
          title="Servers"
          hint="Connect servers and choose which of their tools the agent gets."
        >
          <Button
            size="sm"
            variant="secondary"
            trailingIcon="arrowRight"
            disabled={!onOpenMarketplace}
            onClick={() => onOpenMarketplace?.('mcps')}
          >
            Manage servers
          </Button>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Catalog" fieldId="tools-catalog" description={toolCatalogSummary(catalog)} plain>
        {catalog ? <ToolCatalog catalog={catalog} /> : null}
      </SettingsGroup>
    </SettingsStack>
  )
}
