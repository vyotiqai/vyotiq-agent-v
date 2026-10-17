import { describe, expect, it } from 'vitest'
import { asksForQuiet, cleanTranscript } from '@main/voice/speechText'
import { VOICE_REPLY_TEXT } from '@main/agent/context/userRules'

/**
 * Taken word for word from the kept voice conversations of 2026-10-16 14:55
 * and 2026-10-17 05:58 (workspaces/172161f4…/voice/*.jsonl).
 */
describe('transcripts as the listener wrote them', () => {
  it('drops the listener’s control tokens and trailing tilde', () => {
    expect(cleanTranscript('<|speaker:0|> Hey.')).toBe('Hey.')
    expect(cleanTranscript("<|speaker:0|> I don't know. You tell me.")).toBe("I don't know. You tell me.")
    expect(cleanTranscript('<|speaker:0|> Stop~')).toBe('Stop')
  })

  it('a token with no words is no turn at all (it was sent twice and answered as silence)', () => {
    expect(cleanTranscript('<|speaker:0|>')).toBe('')
  })

  it('leaves Hindi and ordinary words alone', () => {
    expect(cleanTranscript('तुमको चक्की नहीं है, थोड़ा कम करना।')).toBe('तुमको चक्की नहीं है, थोड़ा कम करना।')
    expect(cleanTranscript('Can you check who is Khan Saab?')).toBe('Can you check who is Khan Saab?')
  })
})

describe('asking for quiet gets no “One moment.”', () => {
  it.each(['Just wait.', 'I said just wait.', 'I said wait', 'Okay, keep quiet.', 'Shut up, shut up, shut up.', 'Hold on a second', 'Wait'])(
    '%s',
    (said) => expect(asksForQuiet(said)).toBe(true)
  )

  it.each(['Wait, run the tests first', 'Tell me what we should do.', 'Stop~', 'Hey.', 'quiet mode on the orb please and dark theme'])(
    'not: %s',
    (said) => expect(asksForQuiet(said)).toBe(false)
  )
})

describe('the voice prompt names what the live run got wrong', () => {
  it('says an app request is not done without a call, and how to go quiet', () => {
    expect(VOICE_REPLY_TEXT).toContain('"start a new session" is new_task')
    expect(VOICE_REPLY_TEXT).toContain('call app_control voice_mute')
  })
})
