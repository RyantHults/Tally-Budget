/**
 * Money utilities — all money in this codebase is integer cents.
 * Never use floats for money; parse from provider strings through here only.
 */

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER)

function assertSafeCents(cents: bigint): number {
  if (cents > MAX_SAFE_CENTS || cents < -MAX_SAFE_CENTS) {
    throw new Error('Money value exceeds safe integer range')
  }
  return Number(cents)
}

/**
 * Parse a provider-supplied decimal string (e.g. "-33293.43", "0.125") into
 * integer cents using round-half-even ("bankers' rounding") at the cent level.
 * Throws on anything that isn't a plain decimal number.
 */
export function parseDecimalStringToCents(input: string): number {
  const trimmed = input.trim()
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed)
  if (!m || (!m[2] && !m[3])) {
    throw new Error(`Invalid decimal string: ${JSON.stringify(input)}`)
  }
  const negative = m[1] === '-'
  const intPart = m[2] || '0'
  const frac = m[3] ?? ''

  let cents: bigint
  if (frac.length <= 2) {
    cents = BigInt(intPart) * 100n + BigInt((frac + '00').slice(0, 2))
  } else {
    cents = BigInt(intPart) * 100n + BigInt(frac.slice(0, 2))
    const rest = frac.slice(2)
    const firstRest = rest[0]!
    if (firstRest > '5') {
      cents += 1n
    } else if (firstRest === '5') {
      const isExactTie = /^0*$/.test(rest.slice(1))
      if (!isExactTie) {
        cents += 1n
      } else if (cents % 2n === 1n) {
        // exact tie → round to even
        cents += 1n
      }
    }
  }

  return assertSafeCents(negative ? -cents : cents)
}

/** Format integer cents as a display string, e.g. -123456 -> "-$1,234.56". */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`formatCents expects integer cents, got: ${cents}`)
  }
  const abs = Math.abs(cents)
  const dollars = Math.trunc(abs / 100).toString()
  const grouped = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const rem = (abs % 100).toString().padStart(2, '0')
  return `${cents < 0 ? '-' : ''}$${grouped}.${rem}`
}

export function addCents(a: number, b: number): number {
  for (const v of [a, b]) {
    if (!Number.isInteger(v)) throw new Error(`addCents expects integers, got: ${v}`)
  }
  return assertSafeCents(BigInt(a) + BigInt(b))
}

export function subCents(a: number, b: number): number {
  return addCents(a, -b)
}
