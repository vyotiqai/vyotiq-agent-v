import { contentDisplayText } from '@shared/ipc'
import type { AttachedFile } from '@shared/ipc'
import { MAX_FILES } from './useComposerFiles'
import { MAX_IMAGES } from './useComposerImages'
import {
  extractMentions,
  isSafeWorkspaceRelPath,
  isAutoInjectedWorkspaceRule,
  parseComposerDocument,
  parseRuleFrontmatterBody,
  type ComposerMention
} from './mentionModel'

export type ResolveMentionsResult = {
  text: string
  files: AttachedFile[]
  images: string[]
  error: string | null
  /** True when the caller abandoned this resolve (e.g. workspace switched). */
  stale?: boolean
}

const BROWSER_INSTRUCTION =
  'Prefer browser_* tools this turn when page interaction or inspection helps. Browser tools still follow mode and approval rules.'

function visibleUserText(raw: string): string {
  return parseComposerDocument(raw)
    .map((seg) => (seg.type === 'text' ? seg.value : ''))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function resolveFileMention(
  workspacePath: string,
  path: string
): Promise<AttachedFile | { error: string }> {
  if (!isSafeWorkspaceRelPath(path)) {
    return { error: `Path is outside the workspace: ${path}` }
  }
  if (!window.vyotiq?.workspaceReadText) {
    return { error: `Cannot read ${path}` }
  }
  const res = await window.vyotiq.workspaceReadText({ workspacePath, path })
  if (!res.ok) return { error: res.error }
  return {
    type: 'file',
    name: res.data.name,
    mime: res.data.mime,
    text: res.data.text
  }
}

async function resolveBranchBlock(workspacePath: string): Promise<string> {
  const parts: string[] = ['## Referenced branch diff']
  try {
    const statusRes = await window.vyotiq.gitStatus(workspacePath)
    if (statusRes.ok && statusRes.data.kind === 'ok') {
      const s = statusRes.data.status
      parts.push(
        `Branch: ${s.branch && s.branch !== 'HEAD' ? s.branch : '(detached)'}`,
        `Changed files: ${s.fileCount}${s.truncated ? ' (truncated)' : ''}`,
        `+/-: +${s.added} / -${s.removed}`
      )
      if (s.files.length) {
        parts.push(
          'Files:',
          ...s.files.slice(0, 40).map((f) => `- ${f.status} ${f.path}`)
        )
      }
    } else if (statusRes.ok && statusRes.data.kind === 'not_repo') {
      parts.push('Not a git repository.')
      return parts.join('\n')
    } else if (statusRes.ok && statusRes.data.kind === 'unavailable') {
      parts.push(statusRes.data.detail)
      return parts.join('\n')
    } else if (!statusRes.ok) {
      parts.push(statusRes.error)
      return parts.join('\n')
    }
  } catch {
    // continue to diff
  }

  if (window.vyotiq.gitDiff) {
    try {
      const diffRes = await window.vyotiq.gitDiff({ workspacePath })
      if (diffRes.ok) {
        parts.push('', '### Diff', diffRes.data.content)
      } else {
        parts.push('', `Diff unavailable: ${diffRes.error}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      parts.push('', `Diff unavailable: ${msg}`)
    }
  }
  return parts.join('\n')
}

async function resolveChatBlock(
  workspacePath: string,
  mention: Extract<ComposerMention, { kind: 'chat' }>
): Promise<string> {
  const header = `## Referenced past chat\nTitle: ${mention.title}\nRun id: ${mention.runId}`
  try {
    const res = await window.vyotiq.loadRun(workspacePath, mention.runId)
    if (!res.ok) return header
    const messages = res.data.messages
    const excerpts: string[] = []
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue
      const trimmed = contentDisplayText(m.content).trim()
      if (!trimmed) continue
      excerpts.push(
        `### ${m.role}\n${trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}\n…` : trimmed}`
      )
      if (excerpts.length >= 2) break
    }
    if (!excerpts.length) return header
    return [header, '', ...excerpts].join('\n')
  } catch {
    return header
  }
}

async function resolveDocsBlock(
  workspacePath: string,
  path: string
): Promise<{ block?: string; file?: AttachedFile; error?: string }> {
  const result = await resolveFileMention(workspacePath, path)
  if ('error' in result) return { error: result.error }
  return {
    file: { ...result, name: path },
    block: `## Referenced documentation\nSource: ${path}`
  }
}

async function resolveRuleBlock(workspacePath: string, path: string): Promise<string | { error: string }> {
  if (!isSafeWorkspaceRelPath(path)) {
    return { error: `Path is outside the workspace: ${path}` }
  }
  if (!window.vyotiq?.workspaceReadText) {
    return { error: `Cannot read rule ${path}` }
  }
  const res = await window.vyotiq.workspaceReadText({ workspacePath, path })
  if (!res.ok) return { error: res.error }
  const raw = res.data.text
  if (isAutoInjectedWorkspaceRule(path, raw)) {
    return [
      `## Referenced rule: ${path}`,
      'Already included in the system prompt (auto-injected workspace rule). Follow it there; this mention does not re-paste the body.'
    ].join('\n')
  }
  const body = parseRuleFrontmatterBody(raw)
  return [`## Referenced rule: ${path}`, body || '(empty rule)'].join('\n')
}

async function resolveLintsBlock(
  workspacePath: string,
  diagnosticsKind: 'typecheck' | 'lint'
): Promise<string | { error: string }> {
  if (!window.vyotiq?.workspaceDiagnostics) {
    return { error: 'Diagnostics unavailable' }
  }
  try {
    const res = await window.vyotiq.workspaceDiagnostics({
      workspacePath,
      kind: diagnosticsKind
    })
    if (!res.ok) return { error: res.error }
    const title =
      diagnosticsKind === 'lint'
        ? '## Referenced diagnostics (lint)'
        : '## Referenced diagnostics (typecheck)'
    if (!res.data.ok) {
      return [title, res.data.content].join('\n')
    }
    return [title, res.data.content].join('\n')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: msg }
  }
}

/** Expand composer markers into send text + file attachments. */
export async function resolveComposerMentions(opts: {
  workspacePath: string | null | undefined
  draft: string
  existingFiles: AttachedFile[]
  existingImages?: string[]
  runId?: string | null
  /** Return false after a workspace/run switch so late results are discarded. */
  isCurrent?: () => boolean
}): Promise<ResolveMentionsResult> {
  const stillCurrent = (): boolean => opts.isCurrent?.() !== false
  const staleResult = (): ResolveMentionsResult => ({
    text: '',
    files: [...opts.existingFiles],
    images: [...(opts.existingImages ?? [])],
    error: null,
    stale: true
  })

  const mentions = extractMentions(opts.draft)
  let text = visibleUserText(opts.draft)
  const files = [...opts.existingFiles]
  const images = [...(opts.existingImages ?? [])]
  const problems: string[] = []
  const contextBlocks: string[] = []

  for (const mention of mentions) {
    if (!stillCurrent()) return staleResult()
    switch (mention.kind) {
      case 'file': {
        if (!opts.workspacePath) {
          problems.push(`Cannot attach ${mention.path} (no workspace)`)
          break
        }
        if (!isSafeWorkspaceRelPath(mention.path)) {
          problems.push(`Path is outside the workspace: ${mention.path}`)
          break
        }
        if (files.length >= MAX_FILES) {
          problems.push(`File limit (${MAX_FILES}) — skipped ${mention.path}`)
          break
        }
        const already = files.some((f) => f.name === mention.path || f.name.endsWith(mention.path))
        if (already) break
        const result = await resolveFileMention(opts.workspacePath, mention.path)
        if (!stillCurrent()) return staleResult()
        if ('error' in result) {
          problems.push(result.error)
        } else {
          files.push({
            ...result,
            name: mention.path
          })
        }
        break
      }
      case 'docs': {
        if (!opts.workspacePath) {
          problems.push(`Cannot attach doc ${mention.path} (no workspace)`)
          break
        }
        if (files.length >= MAX_FILES) {
          problems.push(`File limit (${MAX_FILES}) — skipped ${mention.path}`)
          break
        }
        const already = files.some((f) => f.name === mention.path || f.name.endsWith(mention.path))
        const resolved = await resolveDocsBlock(opts.workspacePath, mention.path)
        if (!stillCurrent()) return staleResult()
        if (resolved.error) {
          problems.push(resolved.error)
          break
        }
        if (resolved.block) contextBlocks.push(resolved.block)
        if (resolved.file && !already) files.push(resolved.file)
        break
      }
      case 'rule': {
        if (!opts.workspacePath) {
          problems.push(`Cannot load rule ${mention.path} (no workspace)`)
          break
        }
        const block = await resolveRuleBlock(opts.workspacePath, mention.path)
        if (!stillCurrent()) return staleResult()
        if (typeof block === 'object') problems.push(block.error)
        else contextBlocks.push(block)
        break
      }
      case 'lints': {
        if (!opts.workspacePath) {
          problems.push('Cannot run diagnostics (no workspace)')
          break
        }
        const block = await resolveLintsBlock(opts.workspacePath, mention.diagnosticsKind)
        if (!stillCurrent()) return staleResult()
        if (typeof block === 'object') problems.push(block.error)
        else contextBlocks.push(block)
        break
      }
      case 'branch': {
        if (!opts.workspacePath) {
          problems.push('Cannot load branch diff (no workspace)')
          break
        }
        contextBlocks.push(await resolveBranchBlock(opts.workspacePath))
        if (!stillCurrent()) return staleResult()
        break
      }
      case 'browser': {
        const instruction = BROWSER_INSTRUCTION
        let screenshotNote: string | null = null
        if (opts.workspacePath && opts.runId && window.vyotiq?.readRunArtifact) {
          try {
            const snap = await window.vyotiq.readRunArtifact({
              workspacePath: opts.workspacePath,
              runId: opts.runId,
              name: 'browser/snapshot.jpg'
            })
            if (snap?.ok && snap.data.exists && snap.data.content) {
              if (images.includes(snap.data.content)) {
                screenshotNote = 'Screenshot: browser/snapshot.jpg (already attached)'
              } else if (images.length >= MAX_IMAGES) {
                screenshotNote =
                  'Screenshot: browser/snapshot.jpg exists (image attach limit reached)'
              } else {
                images.push(snap.data.content)
                screenshotNote = 'Screenshot: attached browser/snapshot.jpg'
              }
            }
          } catch {
            /* snapshot is optional */
          }
        }
        try {
          const res = await window.vyotiq.browserGetState?.()
          if (res?.ok && res.data.url?.trim() && res.data.url !== 'about:blank') {
            const title = res.data.title?.trim()
            contextBlocks.push(
              [
                '## Referenced browser',
                `URL: ${res.data.url.trim()}`,
                title ? `Title: ${title}` : null,
                screenshotNote,
                '',
                instruction
              ]
                .filter((line) => line != null)
                .join('\n')
            )
            break
          }
        } catch {
          /* fall through to instruction-only */
        }
        contextBlocks.push(
          [screenshotNote, instruction].filter((line) => line != null).join('\n\n')
        )
        break
      }
      case 'chat': {
        if (!opts.workspacePath) {
          problems.push('Cannot load past chat (no workspace)')
          break
        }
        contextBlocks.push(await resolveChatBlock(opts.workspacePath, mention))
        if (!stillCurrent()) return staleResult()
        break
      }
      case 'slash': {
        // Slash chips are resolved via slash submit before send; ignore here.
        break
      }
      default: {
        const _exhaustive: never = mention
        void _exhaustive
      }
    }
  }

  if (!stillCurrent()) return staleResult()

  if (contextBlocks.length) {
    text = [text, ...contextBlocks].filter(Boolean).join('\n\n')
  }

  return {
    text,
    files,
    images,
    error: problems.length ? problems.join(' · ') : null
  }
}
