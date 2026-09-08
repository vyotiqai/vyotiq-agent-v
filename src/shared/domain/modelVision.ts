import { normalizeModelIdForHeuristics } from './serviceTier'

/**
 * Canonical id heuristic for image input support — shared by live catalog
 * normalization, seed fallback, and Ollama model listing. Conservative by
 * design: only families whose image-capable variants are known match, and the
 * text-only variants (gemma3:1b, o1-mini, o1-preview, o3-mini) stay false so
 * the client never sends images that would 400. GLM: only 5.3-flash and the
 * *v variants accept image input — a broad /glm/i would mis-flag GLM-5.2/4.7.
 */
export function idSuggestsVision(id: string): boolean {
  const normalized = normalizeModelIdForHeuristics(id).toLowerCase()
  if (
    /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-5|vision|llava|claude|gemini|grok|pixtral|mistral-small|mistral-medium|mistral-large|moondream|glm-5\.3-flash|glm-[0-9.]+v|qwen[\d.]*-vl|qvq|minicpm-v|internvl|llama-4|gemma3(?!:1b)/.test(
      normalized
    )
  ) {
    return true
  }
  // o-series: o1/o1-pro/o3/o3-pro/o4-mini accept images; -mini/-preview are
  // text-only. Dated suffixes (o1-pro-2025-03-19) keep the family default.
  return /^o[13](-pro)?(?=$|-\d)|^o4-mini(?=$|-\d)/.test(normalized)
}
