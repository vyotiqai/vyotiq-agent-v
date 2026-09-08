export const SITE_BRAND = 'Vyotiq'

export const SITE_PRODUCT = 'Agent V'

export const SITE_TAGLINE = 'Coding workspace for real repositories'

export const SITE_DESCRIPTION =
  'Agent V brings repository context, editing, terminal work, browser actions, Git review, and configurable models into one coding workspace.'

export const SITE_VERSION = '1.0.0'

export const SITE_URL_FALLBACK = 'https://vyotiq.com'

export const SITE_FEEDBACK_EMAIL = 'vyotiq@gmail.com'

export const SITE_FEEDBACK_SUBJECT = '[Vyotiq feedback]'

export const SITE_FEEDBACK_BODY =
  'What were you doing? What did you expect? What happened instead?'

export function feedbackMailto(
  email: string = SITE_FEEDBACK_EMAIL,
  subject: string = SITE_FEEDBACK_SUBJECT
): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(SITE_FEEDBACK_BODY)}`
}
