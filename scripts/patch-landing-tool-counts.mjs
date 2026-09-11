import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDocumentXml, writeDocumentXml } from './patch-docx-xml.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function listItem(name, desc) {
  const nameRun = `<w:r w:rsidDel="00000000" w:rsidR="00000000" w:rsidRPr="00000000"><w:rPr><w:rFonts w:ascii="Roboto Mono" w:cs="Roboto Mono" w:eastAsia="Roboto Mono" w:hAnsi="Roboto Mono"/><w:color w:val="188038"/><w:rtl w:val="0"/></w:rPr><w:t xml:space="preserve">${escapeXml(name)}</w:t></w:r>`
  const descRun = desc
    ? `<w:r w:rsidDel="00000000" w:rsidR="00000000" w:rsidRPr="00000000"><w:rPr><w:rtl w:val="0"/></w:rPr><w:t xml:space="preserve"> — ${escapeXml(desc)}</w:t></w:r>`
    : ''
  return `<w:p w:rsidR="00000000" w:rsidDel="00000000" w:rsidP="00000000" w:rsidRDefault="00000000" w:rsidRPr="00000000"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720" w:hanging="360"/><w:rPr/></w:pPr>${nameRun}${descRun}</w:p>`
}

function insertAfterName(xml, name, items) {
  const needle = `>${escapeXml(name)}</w:t>`
  const at = xml.indexOf(needle)
  if (at < 0) throw new Error(`missing tool paragraph ${name}`)
  const end = xml.indexOf('</w:p>', at)
  if (end < 0) throw new Error(`unterminated paragraph ${name}`)
  const insertAt = end + '</w:p>'.length
  return xml.slice(0, insertAt) + items.map((item) => listItem(item.name, item.desc)).join('') + xml.slice(insertAt)
}

const toolsPath = path.join(root, 'landing/src/content/docs/reference/tools.md.docx')
let tools = readDocumentXml(toolsPath)
if (!tools.includes('All 59 built-in') && !tools.includes('All 53 built-in')) {
  throw new Error('tools.docx count string not found')
}
tools = tools.replace('All 53 built-in', 'All 59 built-in')
if (!tools.includes('edit_notebook')) {
  tools = insertAfterName(tools, 'delete', [
    {
      name: 'edit_notebook',
      desc: 'insert or uniquely replace one cell in a nbformat v4 .ipynb (no kernel)'
    },
    {
      name: 'lsp',
      desc: 'language-server hover, completions, diagnostics, definition, or rename when a server is on PATH'
    }
  ])
}
if (!tools.includes('run_tests')) {
  tools = insertAfterName(tools, 'diagnostics', [
    {
      name: 'run_tests',
      desc: 'workspace test script or an optional sandboxed command'
    }
  ])
}
if (!tools.includes('git_apply')) {
  tools = insertAfterName(tools, 'git_commit', [
    { name: 'git_apply', desc: 'apply a unified diff with git apply' },
    { name: 'github_pr_create', desc: 'Agent-only; gh pr create (draft default)' },
    { name: 'github_pr_review', desc: 'Agent-only; approve / request-changes / comment' },
    { name: 'github_issue', desc: 'Agent-only; list or create' }
  ])
}
if (!tools.includes('create_plan')) {
  tools = insertAfterName(tools, 'todo_write', [
    { name: 'create_plan', desc: 'write plan.md and contract.md' }
  ])
}
if (!tools.includes('cancel_agent_instance')) {
  tools = insertAfterName(tools, 'merge_agent_instance', [
    { name: 'cancel_agent_instance' }
  ])
}
writeDocumentXml(toolsPath, tools)

const whatPath = path.join(root, 'landing/src/content/docs/concepts/what-it-is.md.docx')
let what = readDocumentXml(whatPath)
what = what.replace('contains 50 tools', 'contains 59 tools')
writeDocumentXml(whatPath, what)

const mcpPath = path.join(root, 'landing/src/content/docs/customize/mcp.md.docx')
let mcp = readDocumentXml(mcpPath)
mcp = mcp.replace("app's 50 built-ins", "app's 59 built-ins")
writeDocumentXml(mcpPath, mcp)

const installPath = path.join(root, 'landing/src/content/docs/start/install.md.docx')
let install = readDocumentXml(installPath)
const oldNotarizeP =
  '<w:t xml:space="preserve">The current package configuration does not notarize the DMG (</w:t></w:r><w:r w:rsidDel="00000000" w:rsidR="00000000" w:rsidRPr="00000000"><w:rPr><w:rFonts w:ascii="Roboto Mono" w:cs="Roboto Mono" w:eastAsia="Roboto Mono" w:hAnsi="Roboto Mono"/><w:color w:val="188038"/><w:rtl w:val="0"/></w:rPr><w:t xml:space="preserve">notarize: false</w:t></w:r><w:r w:rsidDel="00000000" w:rsidR="00000000" w:rsidRPr="00000000"><w:rPr><w:rtl w:val="0"/></w:rPr><w:t xml:space="preserve">). macOS can therefore require an explicit confirmation before first launch.</w:t>'
const newNotarizeP =
  '<w:t xml:space="preserve">The current package configuration leaves notarize: false for local packs. GitHub Releases notarize the macOS DMG only when Apple ID, app-specific password, and team ID secrets are present at pack time. Unsigned builds can require an explicit Gatekeeper confirmation before first launch.</w:t>'
if (install.includes(oldNotarizeP)) {
  install = install.replace(oldNotarizeP, newNotarizeP)
}
install = install.replace(
  'There is no public download page, app store listing, or GitHub release funnel for Agent V.',
  'There is no public download page or app store listing. Tagged GitHub Releases publish installers at https://github.com/vyotiq/vyotiq/releases/latest.'
)
writeDocumentXml(installPath, install)

console.log('[patch-landing-tool-counts] updated tools/what-it-is/mcp/install docx')
