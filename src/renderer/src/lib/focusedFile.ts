let focusedFile: string | null = null

export function setFocusedFile(path: string | null): void {
  focusedFile = path && path.trim() ? path.trim() : null
}

export function getFocusedFile(): string | null {
  return focusedFile
}
