/** The name to show for a user: nickname, then "First Last", then the email's local part. */
export function getUserName(user) {
  if (user.nickname) return user.nickname
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ')
  if (full) return full
  return user.email ? user.email.split('@')[0] : 'anonymous'
}
