import type { AppearanceSettings } from '@shared/appearance'
import type { Ref } from 'react'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import type {
  SecretProvider,
  Settings,
  WorkspaceSettingsOverride
} from '@shared/ipc'

/**
 * Renderer-side nav contract. Two ids cross the shared boundary: the
 * notification `open_settings` action (shared/ipc/schemas/notifications.ts,
 * crash alerts → 'diagnostics') and the composer's dictation error banner
 * ('voice' | 'providers'). Renaming one means updating those call sites plus
 * the in-app `Settings.section` state.
 */
export type SettingsSection =
  // App
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'shortcuts'
  // Agent
  | 'providers'
  | 'agent'
  | 'tools'
  | 'indexing'
  | 'voice'
  // System
  | 'storage'
  | 'diagnostics'
  | 'about'

/** One entry of a settings select. `T` keeps the menu's value typed end to end. */
export type SettingsOption<T extends string = string> = {
  value: T
  label: string
  disabled?: boolean
}

/**
 * Which field owns the current error, so the message renders next to the
 * control instead of as a page-level alert. A field listed here must have an
 * entry in `SETTINGS_ERROR_IDS` and pass that id to `aria-describedby`.
 */
export type SettingsErrorField =
  | 'ollama'
  | 'customUrl'
  | 'apikey'
  | 'keepTurns'
  | 'autoCompactThreshold'
  | 'checkpointKeep'
  | 'checkpointAge'
  | 'orphanGrace'
  | 'sessionKeep'
  | 'sessionAge'
  | 'sizeCap'
  | null

export type SettingsViewProps = {
  settings: Settings
  secrets: Record<SecretProvider, boolean>
  encryptionAvailable?: boolean
  secretsLoadError?: boolean
  /** Errors from App (pick workspace, harness, theme persist, etc.). */
  appError?: string | null
  onDismissAppError?: () => void
  backRef?: Ref<HTMLButtonElement>
  onClose: () => void
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  onSaveSecret: (
    provider: SecretProvider,
    key: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  onClearSecret: (
    provider: SecretProvider
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  onAppearanceChange?: (partial: Partial<AppearanceSettings>) => void
  /** Read error from the app-level custom CSS overlay loader. */
  customCssError?: string | null
  onPickWorkspace?: () => Promise<unknown>
  onModelsRefreshed?: () => void
  activeWorkspacePath?: string | null
  openWorkspaces?: string[]
  settingsOverridesByPath?: Record<string, WorkspaceSettingsOverride>
  /** Composer-effective model for the active workspace (when open). */
  effectiveChatSettings?: EffectiveChatSettings
  onSetSettingsOverride?: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  section?: SettingsSection
  onSectionChange?: (section: SettingsSection) => void
  /** Open the feedback dialog from outside Settings (command palette). */
  feedbackOpen?: boolean
  onFeedbackOpenChange?: (open: boolean) => void
  /** Close Settings and focus the composer model picker. */
  onOpenComposerModel?: () => void
  /**
   * Close Settings on a Marketplace → Manage tab. Rules and MCP servers are
   * edited there; Settings only links to them.
   */
  onOpenMarketplace?: (tab: 'mcps' | 'rules') => void
}
