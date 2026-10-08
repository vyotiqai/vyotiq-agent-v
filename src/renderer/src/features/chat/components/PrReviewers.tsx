import { useEffect, useId, useState } from 'react'
import { Button, IconButton, Input } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'

/** A GitHub login, an `org/team` slug, or gh's `@copilot` — what main accepts. */
const REVIEWER_RE = /^(?:@copilot|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?)$/

/**
 * Who a pull request waits on for review: ask someone (a login or org/team,
 * with the repository's assignable people suggested) or withdraw a request.
 * The list shown afterwards is what GitHub reports, not what was asked for.
 */
export function PrReviewers({
  number,
  requested,
  workspacePath,
  onChanged,
  onNotice
}: {
  number: number
  requested: readonly string[]
  workspacePath: string | null
  /** GitHub's list after a change. */
  onChanged: (reviewRequests: string[]) => void
  onNotice: (message: string, failed: boolean) => void
}) {
  const [login, setLogin] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[] | null>(null)
  const listId = useId()

  useEffect(() => {
    setLogin('')
  }, [number])

  // Suggestions are read once, when the field is first used.
  const loadSuggestions = (): void => {
    if (suggestions || !workspacePath) return
    setSuggestions([])
    void window.vyotiq.prReviewerSuggestions({ workspacePath }).then((res) => {
      if (res.ok) setSuggestions(res.data.logins)
    })
  }

  const change = async (add: string[], remove: string[], key: string): Promise<void> => {
    if (!workspacePath) return
    setBusy(key)
    try {
      const res = await window.vyotiq.prReviewers({ workspacePath, number, add, remove })
      if (!res.ok) {
        onNotice(res.error, true)
        return
      }
      onNotice(res.data.detail, false)
      onChanged(res.data.reviewRequests)
      if (add.length) setLogin('')
    } finally {
      setBusy(null)
    }
  }

  const wanted = login.trim().replace(/^@(?!copilot$)/, '')
  const valid = REVIEWER_RE.test(wanted)
  const offered = (suggestions ?? []).filter((s) => !requested.includes(s))

  return (
    <section className="mb-5" data-pr-reviewers>
      <h4 className={SECTION_LABEL}>Review requested from</h4>
      {requested.length === 0 ? (
        <p className="m-0 mt-1 text-xs text-muted">Nobody yet.</p>
      ) : (
        <ul className="-mx-2 m-0 mt-1 list-none p-0">
          {requested.map((name) => (
            <li key={name} className="flex h-7 items-center gap-2 rounded-md px-2 text-xs">
              <Icon name="eye" size={13} className="shrink-0 text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-fg">{name}</span>
              {workspacePath ? (
                <IconButton
                  icon="close"
                  label={`Withdraw the review request from ${name}`}
                  size="xs"
                  tone="muted"
                  disabled={busy !== null}
                  onClick={() => void change([], [name], `remove:${name}`)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {workspacePath ? (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid && busy === null) void change([wanted], [], 'add')
          }}
        >
          <Input
            size="sm"
            className="min-w-0 flex-1"
            value={login}
            placeholder="GitHub login or org/team"
            aria-label="Request a review from"
            aria-invalid={login.trim() && !valid ? true : undefined}
            list={listId}
            spellCheck={false}
            autoComplete="off"
            onFocus={loadSuggestions}
            onChange={(e) => setLogin(e.target.value)}
          />
          <datalist id={listId}>
            {offered.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <Button size="sm" type="submit" pending={busy === 'add'} disabled={!valid || busy !== null}>
            Request
          </Button>
        </form>
      ) : null}
    </section>
  )
}
