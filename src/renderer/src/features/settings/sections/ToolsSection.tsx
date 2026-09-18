import { useEffect, useRef, useState } from 'react'
import type { TerminalShell, ToolApprovalMode } from '@shared/ipc'
import { Menu, Button, Switch, Textarea } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { TERMINAL_SCREEN_READER_OPTIONS, TERMINAL_SHELL_OPTIONS, TOOL_APPROVAL_OPTIONS } from '../constants'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { ToolCatalogCard } from '../components/ToolCatalogCard'
import {
  formatBrowserDomainAllowlist,
  parseBrowserDomainAllowlist
} from '../utils/settingsHelpers'

export function ToolsSection({ form }: { form: SettingsFormState }) {
  const persistedAllowlist = form.settings.browserDomainAllowlist
  const allowlistKey = (persistedAllowlist ?? []).join('\n')
  const [allowlistDraft, setAllowlistDraft] = useState(() =>
    formatBrowserDomainAllowlist(persistedAllowlist)
  )

  useEffect(() => {
    setAllowlistDraft(allowlistKey)
  }, [allowlistKey])

  const commitBrowserDomainAllowlist = (): void => {
    const next = parseBrowserDomainAllowlist(allowlistDraft)
    const prev = persistedAllowlist ?? []
    if (next.join('\n') === prev.join('\n')) return
    void form.runUpdate({ browserDomainAllowlist: next })
  }
  const commitAllowlistRef = useRef(commitBrowserDomainAllowlist)
  commitAllowlistRef.current = commitBrowserDomainAllowlist
  useEffect(() => () => commitAllowlistRef.current(), [])
  return (
    <SettingsStack>
      {form.workspaceOverrideActive ? (
        <p className="m-0 rounded-xl bg-surface px-4 py-3 text-xs text-secondary">
          Workspace override on — tool approval applies to this workspace only. Shell,
          search engine, browser domain allowlist, and automatic mode switching stay app-wide.
        </p>
      ) : null}

      <SettingsGroup title="Tool catalog">
        <SettingsField
          id="tools-catalog"
          title="Live tool catalog"
          hint="What the agent can actually call right now. Updates live as servers connect, settings change, or runs start."
          help="Built-in tools ship with the app runtime and cannot be removed. MCP tools come from connected servers: add or remove them via the server cards — enable/disable a server, or edit its allowed/denied tool lists. Inactive tools show the exact reason."
          wide
        >
          <ToolCatalogCard />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Approval">
        <SettingsField
          id="tool-approval"
          title="Tool approval"
          hint="Ask before the agent runs tools. Off by default."
          help="Allowlisted tools never ask. Mutating gates edits/commands; All gates every tool including reads."
          wide
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Menu
                aria-label="Tool approval"
                value={form.toolApproval.mode}
                options={TOOL_APPROVAL_OPTIONS}
                searchable={false}
                placement="down"
                disabled={form.formLocked}
                onChange={(v) => {
                  void form.runAgentUpdate({
                    toolApproval: { ...form.toolApproval, mode: v as ToolApprovalMode }
                  })
                }}
              />
              {form.toolApproval.allowlist.length > 0 ? (
                <Button
                  variant="subtle"
                  disabled={form.formLocked}
                  onClick={() => {
                    void form.runAgentUpdate({
                      toolApproval: { ...form.toolApproval, allowlist: [] }
                    })
                  }}
                >
                  Clear {form.toolApproval.allowlist.length} allowed
                </Button>
              ) : null}
            </div>
            {form.toolApproval.allowlist.length > 0 ? (
              <ul className="m-0 list-none space-y-1 pl-0 text-xs text-tertiary">
                {form.toolApproval.allowlist.map((name) => (
                  <li key={name} className="flex items-center justify-between gap-2 font-mono">
                    <span className="min-w-0 truncate">{name}</span>
                    <Button
                      variant="subtle"
                      disabled={form.formLocked}
                      onClick={() => {
                        void form.runAgentUpdate({
                          toolApproval: {
                            ...form.toolApproval,
                            allowlist: form.toolApproval.allowlist.filter((entry) => entry !== name)
                          }
                        })
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          id="mcp-tools-protection"
          title="MCP tools protection"
          hint="Ask before the agent runs tools from connected MCP servers, even when tool approval is off."
          help="Applies to mcp__* server tools. Built-in MCP catalog tools (list, pin, release) follow tool approval. Off = MCP tools follow the global tool approval mode only."
        >
          <Switch
            size="md"
            checked={form.toolApproval.mcpProtection !== false}
            disabled={form.formLocked}
            label="MCP tools protection"
            onCheckedChange={(checked) => {
              void form.runAgentUpdate({
                toolApproval: { ...form.toolApproval, mcpProtection: checked }
              })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Terminal">
        <SettingsField
          id="terminal-shell"
          title="Terminal shell"
          hint="Shell for the terminal tool."
          help="Auto prefers PowerShell on Windows when available."
        >
          <Menu
            aria-label="Terminal shell"
            value={form.settings.terminalShell ?? 'auto'}
            options={TERMINAL_SHELL_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => {
              void form.runUpdate({ terminalShell: v as TerminalShell })
            }}
          />
        </SettingsField>

        <SettingsField
          id="terminal-screen-reader"
          title="Terminal screen reader"
          hint="Accessibility mirror for terminal output."
          help="Auto enables it only when a screen reader or assistive technology is detected. Always on costs extra CPU on fast-scrolling output because xterm maintains a parallel accessibility DOM for every chunk."
        >
          <Menu
            aria-label="Terminal screen reader"
            value={form.settings.terminalScreenReader ?? 'auto'}
            options={TERMINAL_SCREEN_READER_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => {
              void form.runUpdate({
                terminalScreenReader: v as 'auto' | 'on' | 'off'
              })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Browser">
        <SettingsField
          id="browser-domain-allowlist"
          title="Browser domain allowlist"
          hint="When non-empty, the agent browser may only navigate to listed hosts. Empty = allow all."
          help="One hostname per line (or comma-separated). Exact match (example.com) or wildcard suffix (*.example.com). Trailing dots ignored; case-insensitive. Paste full URLs to extract the hostname. Checked on every navigation and redirect."
          wide
        >
          <Textarea
            className="min-h-[72px] font-mono text-xs"
            aria-label="Browser domain allowlist"
            placeholder={'example.com\n*.corp.internal'}
            disabled={form.formLocked}
            rows={4}
            value={allowlistDraft}
            onChange={(e) => {
              setAllowlistDraft(e.target.value)
            }}
            onBlur={() => {
              commitBrowserDomainAllowlist()
            }}
          />
          {allowlistKey ? (
            <p className="m-0 text-xs text-tertiary">
              {(persistedAllowlist ?? []).length} domain
              {(persistedAllowlist ?? []).length === 1 ? '' : 's'} enforced — clear the field to
              allow all hosts.
            </p>
          ) : null}
        </SettingsField>

        <SettingsField
          id="search-engine"
          title="Search engine"
          hint="Used by browser_search in the embedded agent browser."
          help="DuckDuckGo, Bing, or Google for the browser_search tool."
        >
          <Menu
            aria-label="Search engine"
            value={form.settings.searchEngine}
            options={[
              { value: 'duckduckgo', label: 'DuckDuckGo' },
              { value: 'bing', label: 'Bing' },
              { value: 'google', label: 'Google' }
            ]}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => {
              void form.runUpdate({ searchEngine: v as 'duckduckgo' | 'bing' | 'google' })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Runs">
        <SettingsField
          id="auto-resume-interrupted"
          title="Auto-resume interrupted runs"
          hint="When on, opening an interrupted chat resumes automatically instead of showing Continue."
          help="Only applies to the chat you open — does not resume every interrupted run in the workspace."
        >
          <Switch
            size="md"
            checked={form.settings.autoResumeInterruptedRuns ?? false}
            disabled={form.formLocked}
            label="Auto-resume interrupted runs"
            onCheckedChange={(checked) => {
              void form.runUpdate({ autoResumeInterruptedRuns: checked })
            }}
          />
        </SettingsField>

        <SettingsField
          id="max-chat-panes"
          title="Max chat panes"
          hint="How many split session panes can show side by side. Auto fits as many 280px columns as the window allows."
          help="Auto derives the limit from the window width (hard cap 6). A fixed limit may exceed what fits — the pane row scrolls horizontally."
        >
          <Menu
            aria-label="Max chat panes"
            value={String(form.settings.maxChatPanes ?? 0)}
            options={[
              { value: '0', label: 'Auto (fits window)' },
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
              { value: '4', label: '4' },
              { value: '5', label: '5' },
              { value: '6', label: '6' }
            ]}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => {
              void form.runUpdate({ maxChatPanes: Number(v) })
            }}
          />
        </SettingsField>

        <SettingsField
          id="auto-mode-switch"
          title="Automatic mode switching"
          hint="Agent may call switch_mode mid-run. Applies at next step of a live run. Default on."
          help="When off, only you change mode (composer picker or slash). When on, the agent may move between ask, plan, and agent as the task phase changes."
        >
          <Switch
            size="md"
            checked={form.settings.autoModeSwitch ?? false}
            disabled={form.formLocked}
            label="Automatic mode switching"
            onCheckedChange={(checked) => {
              void form.runUpdate({ autoModeSwitch: checked })
            }}
          />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
