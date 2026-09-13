import { resolveFileIcon, resolveFolderIcon } from './resolve'

/** Base URL for Material Icon Theme SVGs (synced into renderer public/). */
function fileIconsBase(): string {
  const base = import.meta.env.BASE_URL || './'
  return base.endsWith('/') ? `${base}file-icons/` : `${base}/file-icons/`
}

function urlForIconId(iconId: string): string {
  const id = iconId.trim() || 'file'
  return `${fileIconsBase()}${encodeURIComponent(id)}.svg`
}

/** Asset URL for a Material icon id (e.g. `typescript`, `react_ts`). */
export function iconUrlForId(iconId: string): string {
  return urlForIconId(iconId)
}

/** Asset URL for a file path. */
export function fileIconUrl(path: string): string {
  return urlForIconId(resolveFileIcon(path))
}

/** Asset URL for a folder name/path. */
export function folderIconUrl(pathOrName: string, open = false): string {
  return urlForIconId(resolveFolderIcon(pathOrName, open))
}
