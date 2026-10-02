/** Take `rate` (0-1) off `base` and round to the cent. */
export function applyDiscount(base, rate) {
  if (typeof base !== 'number' || base < 0) throw new TypeError('base must be a non-negative number')
  const discounted = base - base * rate
  return Math.round(discounted * 100) / 100
}

/** Ticket price for a student: 20% off, rounded to the cent. */
export function priceForStudent(base) {
  return applyDiscount(base, 0.2)
}

/** Ticket price for a senior: 30% off, rounded to the cent. */
export function priceForSenior(base) {
  return applyDiscount(base, 0.3)
}

/** Ticket price for a member: 10% off, rounded to the cent. */
export function priceForMember(base) {
  return applyDiscount(base, 0.1)
}
