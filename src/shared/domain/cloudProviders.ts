/**
 * Where Amazon Bedrock and Google Vertex AI calls go. Both are addressed by
 * cloud location rather than a pasted URL, so settings hold a region (and a
 * project for Vertex) and these build the one host each can reach — the key
 * is never sent anywhere a setting could point at.
 */

export const BEDROCK_DEFAULT_REGION = 'us-east-1'
/** Commercial and GovCloud regions (`us-east-1`, `eu-central-2`, `us-gov-west-1`). */
export const BEDROCK_REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$/

export function bedrockRuntimeBaseUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`
}

export function bedrockRegionFromBaseUrl(baseUrl: string | undefined): string {
  let host = ''
  try {
    host = baseUrl ? new URL(baseUrl).hostname : ''
  } catch {
    host = ''
  }
  const m = /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host)
  return m && BEDROCK_REGION_RE.test(m[1]!) ? m[1]! : BEDROCK_DEFAULT_REGION
}

export const VERTEX_DEFAULT_LOCATION = 'global'
/** `global`, the `us`/`eu` multi-regions, or a region like `us-east5`. */
export const VERTEX_LOCATION_RE = /^(?:global|us|eu|[a-z]+-[a-z]+\d{1,2})$/
/** Google Cloud project ids: 6–30 chars, optionally domain-scoped (`example.com:proj`). */
export const VERTEX_PROJECT_RE = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/

export function vertexHost(location: string): string {
  if (location === 'global') return 'https://aiplatform.googleapis.com'
  if (location === 'us' || location === 'eu') return `https://aiplatform.${location}.rep.googleapis.com`
  return `https://${location}-aiplatform.googleapis.com`
}

/** The project/location base every Vertex model URL hangs off. */
export function vertexBaseUrl(project: string, location: string): string {
  return `${vertexHost(location)}/v1/projects/${encodeURIComponent(project)}/locations/${location}`
}

/** The Vertex secret that means "use this computer's gcloud login" (ADC). */
export const VERTEX_ADC_MARKER = '{"type":"adc"}'
