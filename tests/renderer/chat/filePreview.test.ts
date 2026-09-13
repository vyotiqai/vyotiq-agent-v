import { describe, expect, it } from 'vitest'
import {
  defaultPreviewOpen,
  filePreviewKind,
  imageMimeForPath,
  previewSourceUrl
} from '@renderer/features/chat/components/filePreviewKind'

describe('filePreviewKind', () => {
  it('classifies images, svg, markdown, and html', () => {
    expect(filePreviewKind('logo.PNG')).toBe('image')
    expect(filePreviewKind('a/b/icon.svg')).toBe('svg')
    expect(filePreviewKind('docs/note.md')).toBe('markdown')
    expect(filePreviewKind('index.html')).toBe('html')
    expect(filePreviewKind('src/app.ts')).toBeNull()
  })

  it('defaults images to preview and source files to editor', () => {
    expect(defaultPreviewOpen('image')).toBe(true)
    expect(defaultPreviewOpen('markdown')).toBe(false)
    expect(defaultPreviewOpen(null)).toBe(false)
  })

  it('builds data URLs for binary images and svg text', () => {
    expect(imageMimeForPath('photo.jpg')).toBe('image/jpeg')
    expect(previewSourceUrl('image', 'logo.png', 'aaaa', true)).toBe(
      'data:image/png;base64,aaaa'
    )
    expect(previewSourceUrl('svg', 'icon.svg', '<svg></svg>', false)).toBe(
      'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E'
    )
    expect(previewSourceUrl('markdown', 'a.md', '# hi', false)).toBeNull()
  })
})
