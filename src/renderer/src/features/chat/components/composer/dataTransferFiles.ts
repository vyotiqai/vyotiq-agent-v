/** Files from a paste or drop event. Prefers `files`, then `items` of kind file. */
export function filesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  if (data.files && data.files.length > 0) return Array.from(data.files)
  const items = data.items
  if (!items?.length) return []
  const out: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) out.push(file)
  }
  return out
}
