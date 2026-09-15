import { beforeEach, describe, expect, it, vi } from 'vitest'
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

/**
 * Counts every `pdf.getPage()` call made by the extraction code, so tests can
 * prove that page parsing stops early instead of walking the whole document.
 * The mock wraps unpdf's real getDocumentProxy; all real behavior is preserved
 * (malformed PDFs still reject — they fail inside the actual implementation).
 */
const pdfPageParses = vi.hoisted(() => ({ count: 0 }))

vi.mock('unpdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('unpdf')>()
  return {
    ...actual,
    getDocumentProxy: async (data: unknown, options?: unknown) => {
      const pdf = await actual.getDocumentProxy(data as never, options as never)
      const realGetPage = pdf.getPage.bind(pdf)
      pdf.getPage = (pageNumber: number) => {
        pdfPageParses.count += 1
        return realGetPage(pageNumber)
      }
      return pdf
    }
  }
})

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

/**
 * Minimal valid multi-page PDF built at runtime (no binary fixture on disk):
 * Helvetica text, one text op per wrapped line, correct xref table. Content
 * must be ASCII without parentheses/backslashes so it is a valid PDF literal
 * string. pdf.js drops glyphs outside the MediaBox, so lines are wrapped at
 * 240 chars on a tall 612x2000 page (4pt font, 5pt leading) — everything
 * drawn is extractable.
 */
const PDF_LINE_CHARS = 240

function pdfPageStream(text: string): string {
  const lines: string[] = []
  for (let i = 0; i < text.length; i += PDF_LINE_CHARS) lines.push(text.slice(i, i + PDF_LINE_CHARS))
  let stream = 'BT /F1 4 Tf 72 1994 Td\n'
  lines.forEach((line, idx) => {
    stream += idx === 0 ? `(${line}) Tj\n` : `0 -5 Td (${line}) Tj\n`
  })
  return `${stream}ET`
}

function buildPdf(pages: string[]): Buffer {
  const pageCount = pages.length
  const firstPageObj = 4
  const kids = Array.from({ length: pageCount }, (_, i) => `${firstPageObj + i * 2} 0 R`).join(' ')
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  pages.forEach((text, i) => {
    const stream = pdfPageStream(text)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 2000] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPageObj + i * 2 + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    )
  })
  const parts: string[] = ['%PDF-1.4\n']
  const offsets: number[] = []
  let pos = Buffer.byteLength(parts[0])
  objects.forEach((body, i) => {
    const head = `${i + 1} 0 obj\n`
    const tail = '\nendobj\n'
    offsets.push(pos)
    parts.push(head, body, tail)
    pos += Buffer.byteLength(head) + Buffer.byteLength(body) + Buffer.byteLength(tail)
  })
  const xrefPos = pos
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  parts.push(xref, `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)
  return Buffer.from(parts.join(''), 'latin1')
}

describe('extractAttachment', () => {
  beforeEach(() => {
    pdfPageParses.count = 0
  })

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

  it('reads every page of a small multi-page pdf', async () => {
    const pdf = buildPdf(['hello from page one', 'hello from page two'])
    const out = await extractAttachment({
      name: 'twopages.pdf',
      mime: 'application/pdf',
      data: pdf.toString('base64')
    })
    expect(out.text).toBe('hello from page one\n\nhello from page two')
    expect(out.truncated).toBe(false)
    expect(pdfPageParses.count).toBe(2)
  })

  it('stops parsing pdf pages once the extraction budget is reached', async () => {
    const perPage = 30_000
    const pageCount = 12
    const pdf = buildPdf(Array.from({ length: pageCount }, () => 'x'.repeat(perPage)))
    const out = await extractAttachment({
      name: 'many-pages.pdf',
      mime: 'application/pdf',
      data: pdf.toString('base64')
    })
    // Budget is 2 * MAX_ATTACHMENT_CHARS = 240k chars; with >=30k extractable
    // chars per page the 8th page crosses it, so pages 9..12 must never be
    // parsed. Robust to per-page newline rounding: count <= budget/perPage.
    expect(pdfPageParses.count).toBeLessThanOrEqual(Math.ceil((MAX_ATTACHMENT_CHARS * 2) / perPage))
    expect(pdfPageParses.count).toBeGreaterThan(0)
    expect(pdfPageParses.count).toBeLessThan(pageCount)
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBe(MAX_ATTACHMENT_CHARS + '\n… (truncated)'.length)
    expect(out.text.endsWith('… (truncated)')).toBe(true)
  })

  it('bounds memory on a pathological many-page pdf (peak recorded)', async () => {
    const perPage = 50_000
    const pageCount = 30
    const pdf = buildPdf(Array.from({ length: pageCount }, () => 'y'.repeat(perPage)))
    const before = process.memoryUsage()
    const out = await extractAttachment({
      name: 'pathological.pdf',
      mime: 'application/pdf',
      data: pdf.toString('base64')
    })
    const after = process.memoryUsage()
    console.log(
      `[bounded-pdf-test] pages parsed: ${pdfPageParses.count} of ${pageCount} (${perPage} chars/page)`
    )
    console.log(
      `[bounded-pdf-test] rss before: ${before.rss} after: ${after.rss} delta: ${after.rss - before.rss}`
    )
    console.log(
      `[bounded-pdf-test] heapUsed before: ${before.heapUsed} after: ${after.heapUsed} delta: ${after.heapUsed - before.heapUsed}`
    )
    // Extraction completes, clips to the cap, parses only a handful of pages
    // (>=50k extractable chars/page crosses the 240k budget by page 5), and
    // stays inside a modest memory envelope (no absolute RSS assertions).
    expect(out.truncated).toBe(true)
    expect(pdfPageParses.count).toBeLessThanOrEqual(Math.ceil((MAX_ATTACHMENT_CHARS * 2) / perPage))
    expect(pdfPageParses.count).toBeLessThan(pageCount)
    expect(after.rss - before.rss).toBeLessThan(512 * 1024 * 1024)
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
