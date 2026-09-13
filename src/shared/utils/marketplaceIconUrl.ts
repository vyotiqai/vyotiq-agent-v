/** Max encoded length for catalog icon data URLs (~200KB). */
export const MARKETPLACE_ICON_URL_MAX_LENGTH = 200_000

const ALLOWED_ICON_DATA_URL =
  /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i

/**
 * Catalog icons may only be image data URLs (CSP allows `data:` but not remote http).
 * Rejects javascript:, http(s):, and oversized payloads.
 */
export function isAllowedMarketplaceIconUrl(url: string): boolean {
  const t = url.trim()
  if (!t || t.length > MARKETPLACE_ICON_URL_MAX_LENGTH) return false
  return ALLOWED_ICON_DATA_URL.test(t)
}
