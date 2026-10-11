import { useEffect } from 'react'
import { IconButton, pushToast } from '@renderer/lib/ui'
import { speakText, stopSpeech, useSpeech } from './speechPlayback'
import { useVoiceMode } from './voiceMode'

/**
 * Reads an answer aloud: its `<spoken>` summary, or its first few sentences
 * (docs/voice-mode.md §13.4). Press again to stop. Lives beside Copy on the
 * receipt line, so it is there for every finished answer.
 */
export function ReadAloudButton({ text, owner }: { text: string; owner: string }) {
  const { active, phase, error } = useSpeech(owner)
  // One voice at a time: during a conversation the agent's replies are already spoken.
  const inConversation = useVoiceMode().owner !== null

  useEffect(() => {
    if (error) pushToast(error, 'error')
  }, [error])

  const label = active ? (phase === 'starting' ? 'Starting to read aloud' : 'Stop reading aloud') : 'Read aloud'
  return (
    <IconButton
      icon={active ? 'stop' : 'speaker'}
      label={label}
      size="sm"
      tone="muted"
      active={active}
      aria-pressed={active}
      disabled={inConversation && !active}
      data-read-aloud={active ? phase : 'idle'}
      onClick={() => (active ? stopSpeech() : void speakText(owner, { text, kind: 'answer' }))}
    />
  )
}
