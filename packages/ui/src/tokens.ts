/** Shared design tokens — single source of truth for web (and mobile later). */
export const colors = {
  primary: '#2563eb', // blue-600
  surface: '#ffffff',
  background: '#f8fafc', // slate-50
  positive: '#16a34a', // green-600
  negative: '#dc2626', // red-600
  warning: '#d97706', // amber-600
} as const

export type ColorToken = keyof typeof colors

/** Tailwind theme extension values (consumed via CSS vars in tokens.css). */
export const tailwindVars = Object.fromEntries(
  Object.entries(colors).map(([k, v]) => [`--color-${k}`, v]),
) as Record<`--color-${ColorToken}`, string>
