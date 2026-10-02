import { useEffect, useId, useRef, useState } from 'react'
import type { McpServerStatus, SandboxCapability } from '@shared/ipc'
import { DEFAULT_AGENT_SANDBOX } from '@shared/ipc'
import { Button, Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import {
  AGENT_SANDBOX_MODE_OPTIONS,
  AGENT_SANDBOX_NETWORK_OPTIONS,
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

/** "GitHub", "GitHub and Linear", or a count past two. */
function namesOrCount(servers: readonly McpServerStatus[]): string {
  return servers.length <= 2 ? servers.map((s) => s.name).join(' and ') : String(servers.length)
}

/**
 * How the MCP servers stand, in one line, from main's live status: which are
 * connected and which need something. Null when none is installed, so the
 * field keeps its plain words.
 */
export function mcpServersSummary(servers: readonly McpServerStatus[]): string | null {
  if (servers.length === 0) return null
  const on = servers.filter((s) => s.enabled)
  if (on.length === 0) return servers.length === 1 ? 'Its one server is off.' : `All ${servers.length} are off.`
  const idle = on.filter((s) => !s.connected && !s.connecting)
  const connected = on.filter((s) => s.connected)
  const connecting = on.filter((s) => s.connecting && !s.connected)
  const signIn = idle.filter((s) => s.errorKind === 'sign-in')
  const failing = idle.filter((s) => s.error && s.errorKind !== 'sign-in')
  const parts: string[] = []
  if (connected.length) parts.push(`${namesOrCount(connected)} connected`)
  if (connecting.length) parts.push(`${namesOrCount(connecting)} connecting`)
  if (signIn.length) parts.push(`${namesOrCount(signIn)} ${signIn.length === 1 ? 'needs' : 'need'} sign-in`)
  if (failing.length) parts.push(`${namesOrCount(failing)} can’t connect`)
  return parts.length ? parts.join(' · ') : `${namesOrCount(on)} on, not connected yet`
}

/** Main's MCP status for the open workspace, read when the section opens; null until it answers. */
function useMcpServers(): readonly McpServerStatus[] | null {
  const [servers, setServers] = useState<readonly McpServerStatus[] | null>(null)
  useEffect(() => {
    const read = window.vyotiq?.mcpStatus
    if (!read) return undefined
    let cancelled = false
    void read({})
      .then((res) => {
        if (!cancelled && res.ok) setServers(res.data.servers)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return servers
}

/** Whether main can sandbox commands on this machine; null until it answers. */
function useSandboxCapability(): SandboxCapability | null {
  const [capability, setCapability] = useState<SandboxCapability | null>(null)
  useEffect(() => {
    const read = window.vyotiq?.getSandboxCapability
    if (!read) return undefined
    let cancelled = false
    void read()
      .then((res) => {
        if (!cancelled && res.ok) setCapability(res.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return capability
}

/** The sandbox row's line: what it confines, or why it can't here. */
export function sandboxHint(capability: SandboxCapability | null): string {
  if (!capability) return 'Checking whether this machine can sandbox commands…'
  if (!capability.available) return capability.reason ?? 'This machine cannot sandbox commands.'
  return 'Agent commands write only to the workspace, temp and package caches.'
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
  const mcpServers = useMcpServers()
  const sandboxCapability = useSandboxCapability()
  const allowlistPanelId = useId()

  const sandbox = settings.agentSandbox ?? DEFAULT_AGENT_SANDBOX
  const sandboxOn = sandbox.mode !== 'off'
  const sandboxAvailable = sandboxCapability?.available === true
  // Unavailable: "Workspace only" can't be picked, but a sandbox already on
  // (a settings file from another machine) can still be turned off.
  const sandboxModeOptions = AGENT_SANDBOX_MODE_OPTIONS.map((option) =>
    option.value === 'off' ? option : { ...option, disabled: !sandboxAvailable }
  )

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

      <SettingsGroup title="Sandbox">
        <SegmentedField
          id="agent-sandbox"
          title="Sandbox commands"
          label="Sandbox agent commands"
          hint={sandboxHint(sandboxCapability)}
          help="Covers the agent's terminal, run_tests and diagnostics — never the terminal panel you type into. Sandboxed commands can read the disk except the app's data and ~/.ssh, and write only the workspace (its git folder included, hooks and config excepted), temp and existing package caches. macOS uses sandbox-exec, Linux bubblewrap. Agent-built tools are refused while it is on."
          value={sandbox.mode}
          options={sandboxModeOptions}
          disabled={form.formLocked || (!sandboxAvailable && !sandboxOn)}
          {...form.nestedDefaultMark('agentSandbox', 'mode')}
          onChange={(mode) => {
            void form.runUpdate({ agentSandbox: { ...sandbox, mode } })
          }}
        />
        <SegmentedField
          id="agent-sandbox-network"
          title="Network"
          label="Sandboxed command network"
          hint="Deny cuts sandboxed commands off the internet."
          help="On macOS localhost stays reachable. On Linux the command gets its own empty network, so the host's localhost is unreachable too."
          nested
          value={sandbox.network}
          options={AGENT_SANDBOX_NETWORK_OPTIONS}
          disabled={form.formLocked || !sandboxOn || !sandboxAvailable}
          {...form.nestedDefaultMark('agentSandbox', 'network')}
          onChange={(network) => {
            void form.runUpdate({ agentSandbox: { ...sandbox, network } })
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
          hint={(mcpServers && mcpServersSummary(mcpServers)) ?? 'Connect servers and choose which of their tools the agent gets.'}
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
