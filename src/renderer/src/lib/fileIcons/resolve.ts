import { basename } from '@shared/utils/path'
import { getFileIconManifest } from './manifest'

function defaultFileIcon(): string {
  return getFileIconManifest().file || 'file'
}

function defaultFolderIcon(open: boolean): string {
  const m = getFileIconManifest()
  return (open ? m.folderExpanded : m.folder) || (open ? 'folder-open' : 'folder')
}

/**
 * Resolve a Material Icon Theme icon id for a file path.
 * Order: exact file name → longest file extension → default file icon.
 */
export function resolveFileIcon(path: string): string {
  const m = getFileIconManifest()
  const name = basename(path)
  if (!name) return defaultFileIcon()

  const lower = name.toLowerCase()
  const byName = m.fileNames?.[lower] ?? m.fileNames?.[name]
  if (byName) return byName

  const parts = lower.split('.')
  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      const ext = parts.slice(i).join('.')
      const byExt = m.fileExtensions?.[ext]
      if (byExt) return byExt
    }
  }

  return defaultFileIcon()
}

/**
 * Resolve a Material Icon Theme icon id for a folder name or path.
 */
export function resolveFolderIcon(pathOrName: string, open = false): string {
  const m = getFileIconManifest()
  const name = basename(pathOrName).toLowerCase()
  if (!name) return defaultFolderIcon(open)

  const map = open ? m.folderNamesExpanded : m.folderNames
  const byName = map?.[name]
  if (byName) return byName

  return defaultFolderIcon(open)
}
