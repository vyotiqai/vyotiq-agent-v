/** Ticket price for a student: 20% off, rounded to the cent. */
export function priceForStudent(base) {
  if (typeof base !== 'number' || base < 0) throw new TypeError('base must be a non-negative number')
  const discounted = base - base * 0.2
  return Math.round(discounted * 100) / 100
}

/** Ticket price for a senior: 30% off, rounded to the cent. */
export function priceForSenior(base) {
  if (typeof base !== 'number' || base < 0) throw new TypeError('base must be a non-negative number')
  const discounted = base - base * 0.3
  return Math.round(discounted * 100) / 100
}

/** Ticket price for a member: 10% off, rounded to the cent. */
export function priceForMember(base) {
  if (typeof base !== 'number' || base < 0) throw new TypeError('base must be a non-negative number')
  const discounted = base - base * 0.1
  return Math.round(discounted * 100) / 100
}
