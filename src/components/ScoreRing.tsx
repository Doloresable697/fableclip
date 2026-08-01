'use client'

/**
 * The one piece of colour in the interface.
 *
 * A number alone reads as arbitrary, and a bar reads as a progress indicator —
 * a ring that fills and shifts hue says "this is a rating" before you have
 * read anything. The ramp is deliberately narrow: grey through to green, so a
 * 40 and an 85 are obviously different without the page turning into a
 * traffic light.
 */
function ramp(score: number): string {
  if (score >= 80) return 'var(--s-great)'
  if (score >= 68) return 'var(--s-good)'
  if (score >= 52) return 'var(--s-mid)'
  return 'var(--s-weak)'
}

interface Props {
  score: number
  size?: number
  label?: string
}

export function ScoreRing({ score, size = 40, label }: Props) {
  const stroke = size <= 40 ? 3 : 4
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const filled = (Math.min(100, Math.max(0, score)) / 100) * circumference

  return (
    <div
      className="ring"
      style={{ width: size, height: size }}
      title={label ? `${score} — ${label}` : String(score)}
    >
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="rgba(6,6,8,0.72)"
          stroke="var(--edge)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={ramp(score)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          style={{ transition: 'stroke-dasharray 0.5s var(--ease)' }}
        />
      </svg>
      <span
        className="ring-num"
        style={{ fontSize: size <= 40 ? 13 : 17, color: ramp(score) }}
      >
        {Math.round(score)}
      </span>
    </div>
  )
}
