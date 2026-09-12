import type { AppearanceSettings } from '@shared/appearance'
import type { Ref } from 'react'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import type {
  SecretProvider,
  Settings,
  WorkspaceSettingsOverride
} from '@shared/ipc'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'providers'
  | 'agent'
  | 'indexing'
  | 'voice'
  | 'storage'
  | 'tools'
  | 'shortcuts'
  | 'about'

export type SettingsErrorField =
  | 'ollama'
  | 'customUrl'
  | 'apikey'
  | 'keepTurns'
  | 'autoCompactThreshold'
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
  /** Reload settings from main after main-only writes (e.g. marketplace ack). */
  onReloadSettings?: () => Promise<void>
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
}
