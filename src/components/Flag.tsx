// Flag.tsx — renders flag images via flagcdn.com (works on Windows, Android, all platforms)
// Falls back to emoji if the image fails to load

/** Extract ISO code from a flag emoji — handles regional-indicator AND TAG sequences (England, Scotland, Wales) */
export function flagToIso(emoji: string): string {
  if (!emoji) return ''
  const chars = [...emoji]

  // TAG-encoded subdivision flags: 🏴 + tag letters + U+E007F
  // England 🏴󠁧󠁢󠁥󠁮󠁧󠁿 → "gb-eng", Scotland → "gb-sct", Wales → "gb-wls"
  if (chars[0]?.codePointAt(0) === 0x1F3F4) {
    const tagLetters: string[] = []
    for (let i = 1; i < chars.length; i++) {
      const cp = chars[i].codePointAt(0) ?? 0
      if (cp === 0xE007F) break
      if (cp >= 0xE0061 && cp <= 0xE007A) tagLetters.push(String.fromCharCode(cp - 0xE0020))
    }
    if (tagLetters.length >= 4) {
      const raw = tagLetters.join('').toLowerCase()   // e.g. "gbeng"
      return raw.slice(0, 2) + '-' + raw.slice(2)     // e.g. "gb-eng"
    }
  }

  // Standard regional-indicator country flags (e.g. 🇧🇷 → "br")
  if (chars.length < 2) return ''
  const a = chars[0].codePointAt(0)! - 0x1F1E6
  const b = chars[1].codePointAt(0)! - 0x1F1E6
  if (a < 0 || a > 25 || b < 0 || b > 25) return ''
  return String.fromCharCode(65 + a, 65 + b).toLowerCase()
}

/** Return a flagcdn.com URL for a flag emoji */
export function getFlagUrl(emoji: string, size: 20 | 40 | 80 = 20): string {
  const iso = flagToIso(emoji)
  if (!iso) return ''
  return `https://flagcdn.com/w${size}/${iso}.png`
}

interface FlagProps {
  emoji: string          // e.g. FLAGS['ברזיל'] = '🇧🇷'
  size?: number          // px width (height scales proportionally)
  style?: React.CSSProperties
  alt?: string
}

/** Cross-platform flag image using flagcdn.com */
export default function Flag({ emoji, size = 20, style, alt = '' }: FlagProps) {
  const iso = flagToIso(emoji)
  if (!iso) return <span style={style}>{emoji}</span>

  // Use 20px CDN image for small sizes, 40px for larger
  const cdnSize = size > 28 ? 40 : 20

  return (
    <img
      src={`https://flagcdn.com/w${cdnSize}/${iso}.png`}
      srcSet={`https://flagcdn.com/w${cdnSize * 2}/${iso}.png 2x`}
      width={size}
      alt={alt || iso.toUpperCase()}
      onError={(e) => {
        // Fallback to emoji text if image fails
        const span = document.createElement('span')
        span.textContent = emoji
        e.currentTarget.replaceWith(span)
      }}
      style={{ display: 'inline-block', verticalAlign: 'middle', borderRadius: 2, ...style }}
    />
  )
}
