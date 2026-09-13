import { describe, expect, it } from 'vitest'
import { extractAttachment } from '@main/attachments/extract'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHARS,
  attachedFileToText,
  buildUserContent,
  contentDisplayText,
  contentToText,
  flattenFileParts,
  providerContentParts
} from '@shared/ipc'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('extractAttachment', () => {
  it('reads a text file as-is', async () => {
    const out = await extractAttachment({
      name: 'notes.md',
      mime: 'text/markdown',
      data: b64('# Title\n\nbody')
    })
    expect(out.text).toBe('# Title\n\nbody')
    expect(out.truncated).toBe(false)
  })

  it('accepts source files the browser reports with no mime type', async () => {
    const out = await extractAttachment({ name: 'main.rs', mime: '', data: b64('fn main() {}') })
    expect(out.text).toBe('fn main() {}')
    expect(out.mime).toBe('text/plain')
  })

  it('rejects binary content that is not a supported document', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64')
    await expect(
      extractAttachment({ name: 'blob.bin', mime: 'application/octet-stream', data: bytes })
    ).rejects.toThrow(/not a text or PDF file/)
  })

  it('rejects a text file whose bytes contain NUL', async () => {
    const bytes = Buffer.concat([Buffer.from('ok'), Buffer.from([0])]).toString('base64')
    await expect(
      extractAttachment({ name: 'weird.txt', mime: 'text/plain', data: bytes })
    ).rejects.toThrow(/not a text or PDF file/)
  })

  it('rejects files over the byte cap', async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41).toString('base64')
    await expect(
      extractAttachment({ name: 'huge.txt', mime: 'text/plain', data: big })
    ).rejects.toThrow(/larger than/)
  })

  it('truncates text past the character cap', async () => {
    const long = 'x'.repeat(MAX_ATTACHMENT_CHARS + 500)
    const out = await extractAttachment({ name: 'long.txt', mime: 'text/plain', data: b64(long) })
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThan(long.length)
    expect(out.text.endsWith('… (truncated)')).toBe(true)
  })

  it('reports a readable error when a PDF cannot be parsed', async () => {
    await expect(
      extractAttachment({ name: 'broken.pdf', mime: 'application/pdf', data: b64('not a pdf') })
    ).rejects.toThrow(/Could not read text from broken\.pdf/)
  })
})

describe('file content parts', () => {
  const content = buildUserContent('look at this', undefined, [
    { type: 'file', name: 'spec.md', mime: 'text/markdown', text: 'rules here' }
  ])

  it('keeps the attachment as its own part', () => {
    expect(Array.isArray(content)).toBe(true)
    expect(content).toContainEqual({
      type: 'file',
      name: 'spec.md',
      mime: 'text/markdown',
      text: 'rules here'
    })
  })

  it('leaves the display text free of the quoted document', () => {
    expect(contentDisplayText(content)).toBe('look at this')
  })

  it('inlines the attachment for the model', () => {
    expect(contentToText(content)).toContain('<attachment name="spec.md"')
    expect(contentToText(content)).toContain('rules here')
  })

  it('flattens to text parts before a provider sees it', () => {
    const flat = flattenFileParts(content)
    expect(Array.isArray(flat) && flat.every((part) => part.type === 'text')).toBe(true)
    expect(providerContentParts(content as never)).toEqual([
      { type: 'text', text: 'look at this' },
      {
        type: 'text',
        text: attachedFileToText({
          type: 'file',
          name: 'spec.md',
          mime: 'text/markdown',
          text: 'rules here'
        })
      }
    ])
  })

  it('drops attachments with no extracted text', () => {
    expect(
      buildUserContent('hi', undefined, [{ type: 'file', name: 'empty.txt', mime: '', text: '' }])
    ).toBe('hi')
  })
})
