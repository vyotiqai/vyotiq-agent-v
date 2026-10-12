import { pushToast } from '@renderer/lib/ui/toastStore'

/** What an "Open in editor" names: a workspace file (at a line), the workspace (`.`), or an instance worktree. */
export type EditorTarget = {
  workspacePath: string
  path?: string
  worktreePath?: string
  line?: number
  column?: number
}

const EDITOR_NAMES: Record<string, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublime: 'Sublime Text',
  webstorm: 'WebStorm',
  idea: 'IntelliJ IDEA',
  pycharm: 'PyCharm',
  system: 'the default app'
}

export function editorName(id: string): string {
  return EDITOR_NAMES[id] ?? id
}

/** Open it in the person's editor (Settings › General); a failure says why. */
export async function openInEditor(target: EditorTarget): Promise<boolean> {
  const res = await window.vyotiq?.editorOpen?.(target)
  if (!res) {
    pushToast('Opening in an editor is not available here.', 'error')
    return false
  }
  if (!res.ok) {
    pushToast(res.error, 'error')
    return false
  }
  return true
}
