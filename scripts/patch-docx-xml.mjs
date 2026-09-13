/**
 * Replace word/document.xml inside a .docx (zip) via PowerShell ZipFile Update.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZipEntry } from './sync-harness.mjs'

const psScript = `
param($ZipPath, $XmlPath)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$resolved = (Resolve-Path -LiteralPath $ZipPath).Path
$zip = [System.IO.Compression.ZipFile]::Open($resolved, 'Update')
$old = $zip.GetEntry('word/document.xml')
if ($old -ne $null) { $old.Delete() }
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $XmlPath).Path)
$created = $zip.CreateEntry('word/document.xml', [System.IO.Compression.CompressionLevel]::Optimal)
$stream = $created.Open()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Close()
$zip.Dispose()
`

export function readDocumentXml(docxPath) {
  return readZipEntry(readFileSync(docxPath), 'word/document.xml').toString('utf8')
}

export function writeDocumentXml(docxPath, xml) {
  const dir = mkdtempSync(join(tmpdir(), 'vyotiq-docx-'))
  const xmlPath = join(dir, 'document.xml')
  const scriptPath = join(dir, 'update.ps1')
  writeFileSync(xmlPath, xml, 'utf8')
  writeFileSync(scriptPath, psScript, 'utf8')
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-File', scriptPath, '-ZipPath', docxPath, '-XmlPath', xmlPath],
    { stdio: 'inherit' }
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.error('import patch-docx-xml.mjs as a library')
  process.exit(1)
}
