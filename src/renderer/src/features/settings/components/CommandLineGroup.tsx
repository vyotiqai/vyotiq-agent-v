import { useEffect, useRef, useState } from 'react'
import type { CliPathStatus } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import { SettingsField, SettingsGroup } from './SettingsField'

/**
 * Settings › General › Command line: put `vyotiq` on your user PATH, or take
 * it off. Windows only; a build that isn't installed has no command to add.
 */
export function CommandLineGroup({
  disabled,
  onError
}: {
  disabled: boolean
  onError: (message: string) => void
}) {
  const [status, setStatus] = useState<CliPathStatus | null>(null)
  const [pending, setPending] = useState(false)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Once per visit: each read starts PowerShell.
  useEffect(() => {
    let live = true
    void window.vyotiq?.cliPathStatus?.().then((res) => {
      if (!live) return
      if (res.ok) setStatus(res.data)
      else onErrorRef.current(res.error)
    })
    return () => {
      live = false
    }
  }, [])

  const toggle = (): void => {
    if (!status) return
    setPending(true)
    void window.vyotiq
      .cliPathSet({ onPath: !status.onPath })
      .then((res) => {
        if (res.ok) setStatus(res.data)
        else onError(res.error)
      })
      .finally(() => setPending(false))
  }

  const usage = (
    <>
      <span className="whitespace-nowrap font-mono">vyotiq .</span> opens the folder you are in;{' '}
      <span className="whitespace-nowrap font-mono">{'vyotiq --prompt "…"'}</span> runs a task with no window.
    </>
  )

  return (
    <SettingsGroup title="Command line">
      <SettingsField
        id="command-line"
        title="vyotiq command"
        hint={
          !status ? (
            usage
          ) : !status.available ? (
            'Only an installed Agent V can put itself on your PATH.'
          ) : status.onPath ? (
            <>On your PATH, for terminals opened from now on. {usage}</>
          ) : (
            usage
          )
        }
        help="Adds the folder holding vyotiq.cmd to your user PATH, and nothing else; Remove takes it off, and so does uninstalling. Options after --prompt are those of a headless run."
      >
        <Button
          size="sm"
          variant="secondary"
          pending={pending}
          disabled={disabled || !status?.available}
          onClick={toggle}
        >
          {status?.onPath ? (pending ? 'Removing…' : 'Remove from PATH') : pending ? 'Adding…' : 'Add to PATH'}
        </Button>
      </SettingsField>
    </SettingsGroup>
  )
}
