/**
 * Vyotiq's own Google OAuth client for the hosted Gmail/Drive/Calendar MCP
 * servers.
 *
 * Google's MCP endpoints answer `initialize` unauthenticated and publish no
 * RFC 9728 protected-resource metadata, so there is no dynamic client
 * registration to fall back on: a client id is genuinely required. Asking each
 * user to create a Google Cloud project for it is a developer chore in front of
 * a consumer feature, so the app ships its own client instead.
 *
 * The credential is injected at build time (see `define` in
 * electron.vite.config.ts) and is empty in a plain dev checkout, which leaves
 * the manual "paste your own client" path as the only option — exactly the
 * behaviour that shipped before this existed.
 *
 * Registered as a Google **Desktop app** client, whose secret Google documents
 * as non-confidential: the security of the flow rests on PKCE plus the loopback
 * redirect, not on hiding this value. That is the same posture as gcloud and
 * every other installed-app OAuth client.
 */

/** Replaced at build time; `''` in dev and in any build without the env vars. */
const BUILD_CLIENT_ID = process.env.VYOTIQ_GOOGLE_MCP_CLIENT_ID ?? ''
const BUILD_CLIENT_SECRET = process.env.VYOTIQ_GOOGLE_MCP_CLIENT_SECRET ?? ''

export type BundledGoogleMcpClient = {
  client_id: string
  client_secret?: string
}

/**
 * The shipped client, or undefined when this build has none.
 * Google requires the secret for the authorization-code exchange even on
 * Desktop clients, so a build with only an id is treated as unconfigured
 * rather than half-working.
 */
export function bundledGoogleMcpClient(): BundledGoogleMcpClient | undefined {
  const id = BUILD_CLIENT_ID.trim()
  const secret = BUILD_CLIENT_SECRET.trim()
  if (!id || !secret) return undefined
  return { client_id: id, client_secret: secret }
}

export function hasBundledGoogleMcpClient(): boolean {
  return bundledGoogleMcpClient() !== undefined
}
