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

export function buildPdf(pages: string[]): Buffer {
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
