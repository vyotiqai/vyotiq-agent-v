import { describe, expect, it } from 'vitest'
import { signAwsRequest } from '@main/agent/providers/aws/sigv4'
import {
  decodeEventStreamMessage,
  encodeEventStreamMessage,
  EventStreamDecodeError,
  iterateEventStream
} from '@main/agent/providers/aws/eventStream'

const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
}
const NOW = new Date('2015-08-30T12:36:00Z')

describe('signAwsRequest', () => {
  it('matches the AWS SigV4 test suite get-vanilla vector', () => {
    const headers = signAwsRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: {},
      body: '',
      region: 'us-east-1',
      service: 'service',
      credentials: CREDS,
      now: NOW
    })
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    )
    expect(headers['x-amz-date']).toBe('20150830T123600Z')
    expect(headers.host).toBe('example.amazonaws.com')
  })

  // Expected signatures below were produced by the independent aws4@1.13.2
  // signer for the same requests (content-length signed on both sides).
  const bedrock = (url: string, body: string, sessionToken?: string) =>
    signAwsRequest({
      method: url.includes('converse') ? 'POST' : 'GET',
      url,
      headers: {
        'content-type': 'application/json',
        ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {})
      },
      body,
      region: 'us-west-2',
      service: 'bedrock',
      credentials: sessionToken ? { ...CREDS, sessionToken } : CREDS,
      now: NOW
    }).authorization

  it('double-encodes a model id with a colon in the path, as AWS signs it', () => {
    const url =
      'https://bedrock-runtime.us-west-2.amazonaws.com/model/' +
      encodeURIComponent('us.anthropic.claude-sonnet-4-5-20250929-v1:0') +
      '/converse-stream'
    expect(bedrock(url, '{"messages":[]}')).toContain(
      'Signature=3b3ad0963b8aa83027514b5dd095005807bd4c8078e625bb558c1f579705eaf5'
    )
  })

  it('signs an inference-profile ARN, a sorted query and a session token', () => {
    const arn =
      'https://bedrock-runtime.us-west-2.amazonaws.com/model/' +
      encodeURIComponent(
        'arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.meta.llama3-1-8b-instruct-v1:0'
      ) +
      '/converse-stream'
    expect(bedrock(arn, '{}')).toContain(
      'Signature=3ed1e14ae6b58297f46dc342c189be4e292beaeeedd71da31cea054d5c93f5e0'
    )
    const session = bedrock(
      'https://bedrock-runtime.us-west-2.amazonaws.com/model/x/converse-stream',
      'hello world',
      'TOKEN/abc+='
    )
    expect(session).toContain('SignedHeaders=content-length;content-type;host;x-amz-date;x-amz-security-token')
    expect(session).toContain(
      'Signature=f5ac48303ef94d723a2fc89f89520384483b22147d4c4cf687c90eb188a1675f'
    )
  })
})

// Official vectors from smithy-lang/smithy-typescript
// packages/eventstream-codec/test_vectors (Apache-2.0).
const VECTOR = {
  all_headers:
    'AAAAzAAAAK8PrmTKCmV2ZW50LXR5cGUEAACgDAxjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uCmJvb2wgZmFsc2UBCWJvb2wgdHJ1ZQAEYnl0ZQLPCGJ5dGUgYnVmBgAUSSdtIGEgbGl0dGxlIHRlYXBvdCEJdGltZXN0YW1wCAAAAAAAhF/tBWludDE2AwAqBWludDY0BQAAAAACh1eyBHV1aWQJAQIDBAUGBwgJCgsMDQ4PEHsnZm9vJzonYmFyJ32rpfEM',
  empty_message: 'AAAAEAAAAAAFwkjrfZjI/w==',
  int32_header: 'AAAALQAAABBBxCS4CmV2ZW50LXR5cGUEAACgDHsnZm9vJzonYmFyJ3029ICg',
  payload_no_headers: 'AAAAHQAAAAD9Uoxaeydmb28nOidiYXInfcNlOTY=',
  payload_one_str_header:
    'AAAAPQAAACAH/YOWDGNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb257J2Zvbyc6J2Jhcid9jZwIsQ==',
  corrupted_header_len:
    'AAAAPQAAACEH/YOWDGNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb257J2Zvbyc6J2Jhcid9jZwIsQ==',
  corrupted_headers:
    'AAAAPQAAACAH/YOWDGNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb257YWZvbyc6J2Jhcid9jZwIsQ==',
  corrupted_length:
    'AAAAPgAAACAH/YOWDGNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb257J2Zvbyc6J2Jhcid9jZwIsQ==',
  corrupted_payload: 'AAAAHQAAAAD9UoxaWydmb28nOidiYXInfcNlOTY='
}
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const text = (u: Uint8Array) => Buffer.from(u).toString('utf8')

describe('AWS event stream decoder', () => {
  it('decodes every positive vector', () => {
    const all = decodeEventStreamMessage(bytes(VECTOR.all_headers))
    expect(all.headers).toMatchObject({
      'event-type': 40972,
      'content-type': 'application/json',
      'bool false': false,
      'bool true': true,
      byte: -49,
      int16: 42,
      int64: 42424242n
    })
    expect(text(all.headers['byte buf'] as Uint8Array)).toBe("I'm a little teapot!")
    expect((all.headers.timestamp as Date).getTime()).toBe(8675309)
    expect([...(all.headers.uuid as Uint8Array)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    expect(text(all.payload)).toBe("{'foo':'bar'}")

    expect(decodeEventStreamMessage(bytes(VECTOR.empty_message))).toEqual({ headers: {}, payload: new Uint8Array(0) })
    expect(decodeEventStreamMessage(bytes(VECTOR.int32_header)).headers).toEqual({ 'event-type': 40972 })
    expect(text(decodeEventStreamMessage(bytes(VECTOR.payload_no_headers)).payload)).toBe("{'foo':'bar'}")
    expect(decodeEventStreamMessage(bytes(VECTOR.payload_one_str_header)).headers).toEqual({
      'content-type': 'application/json'
    })
  })

  it('rejects every negative vector', () => {
    expect(() => decodeEventStreamMessage(bytes(VECTOR.corrupted_header_len))).toThrow(/prelude checksum/)
    expect(() => decodeEventStreamMessage(bytes(VECTOR.corrupted_headers))).toThrow(/message checksum/)
    expect(() => decodeEventStreamMessage(bytes(VECTOR.corrupted_length))).toThrow(EventStreamDecodeError)
    expect(() => decodeEventStreamMessage(bytes(VECTOR.corrupted_payload))).toThrow(/message checksum/)
  })

  it('round-trips its own encoder byte for byte against a vector', () => {
    expect(
      Buffer.from(encodeEventStreamMessage({ 'content-type': 'application/json' }, "{'foo':'bar'}")).toString('base64')
    ).toBe(VECTOR.payload_one_str_header)
  })

  it('yields messages split across arbitrary chunk boundaries and flags a cut frame', async () => {
    const frames = [
      encodeEventStreamMessage({ ':event-type': 'a' }, '{"n":1}'),
      encodeEventStreamMessage({ ':event-type': 'b' }, '{"n":2}')
    ]
    const joined = Buffer.concat(frames.map((f) => Buffer.from(f)))
    const chunked = (buf: Buffer, size: number) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < buf.length; i += size) c.enqueue(new Uint8Array(buf.subarray(i, i + size)))
            c.close()
          }
        })
      )
    const signal = new AbortController().signal
    for (const size of [1, 7, 1000]) {
      const seen: string[] = []
      for await (const m of iterateEventStream(chunked(joined, size), signal)) {
        seen.push(`${m.headers[':event-type']}${text(m.payload)}`)
      }
      expect(seen).toEqual(['a{"n":1}', 'b{"n":2}'])
    }
    const cut = joined.subarray(0, joined.length - 3)
    await expect(async () => {
      for await (const _ of iterateEventStream(chunked(cut, 5), signal)) void _
    }).rejects.toThrow(/middle of a message/)
  })
})
