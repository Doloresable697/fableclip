/**
 * Inline SVG icon set. Deliberately hand-rolled rather than pulled from a
 * package: this app must install and run with no network, and an icon
 * dependency is not worth a megabyte of node_modules.
 *
 * All icons share a 24x24 viewBox and inherit `currentColor`.
 */

interface IconProps {
  size?: number
  className?: string
}

function svgProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  }
}

/**
 * The mark: a wide frame with a tall one cut out of it, which is the whole
 * product in one shape — 16:9 in, 9:16 out.
 */
export function ClipMark({ size = 22, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      className={className}
      aria-hidden
    >
      <path d="M2.6 5.5A2.5 2.5 0 0 1 5.1 3h13.8a2.5 2.5 0 0 1 2.5 2.5v13a2.5 2.5 0 0 1-2.5 2.5H5.1a2.5 2.5 0 0 1-2.5-2.5v-13Zm2.5-.7a.7.7 0 0 0-.7.7v13c0 .4.3.7.7.7h3.6V4.8H5.1Zm10.2 0v14.4h3.6a.7.7 0 0 0 .7-.7v-13a.7.7 0 0 0-.7-.7h-3.6Z" />
      <path d="M10.6 4.8h2.8v14.4h-2.8V4.8Z" opacity="0.45" />
    </svg>
  )
}

export function Play({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M8 5.2c0-.8.9-1.3 1.6-.9l9 6.8c.6.4.6 1.4 0 1.8l-9 6.8c-.7.4-1.6-.1-1.6-.9V5.2Z" />
    </svg>
  )
}

export function Check({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} strokeWidth={2.2}>
      <path d="m20 6-11 11-5-5" />
    </svg>
  )
}

export function Chevron({ size = 13, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} strokeWidth={2}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function ArrowRight({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} strokeWidth={2}>
      <path d="M4 12h15m0 0-6-6m6 6-6 6" />
    </svg>
  )
}

export function Download({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" />
    </svg>
  )
}

export function Trash({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 6h16M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6m2.5 0-.6 13.1a1.5 1.5 0 0 1-1.5 1.4H8.6a1.5 1.5 0 0 1-1.5-1.4L6.5 6" />
    </svg>
  )
}

export function Cog({ size = 15, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.4 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.4-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 1 1.4 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1Z" />
    </svg>
  )
}

export function Close({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} strokeWidth={2}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

export function Spinner({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, `spin ${className ?? ''}`)} strokeWidth={2.4}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

export function Alert({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.3v.2" />
    </svg>
  )
}

export function Scissors({ size = 15, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <path d="M20 4 8.6 16.4M8.6 7.6 20 20" />
    </svg>
  )
}

export function Upload({ size = 15, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" />
    </svg>
  )
}

export function Link({ size = 15, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M10 13.5a4 4 0 0 0 5.7.4l2.8-2.8a4 4 0 1 0-5.7-5.7L11.5 7" />
      <path d="M14 10.5a4 4 0 0 0-5.7-.4l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3" />
    </svg>
  )
}

export function Refresh({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M20 11a8 8 0 1 0-.7 4.2M20 5v6h-6" />
    </svg>
  )
}

export function Sliders({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </svg>
  )
}

export function Captions({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M10 10.2a2.4 2.4 0 1 0 0 3.6M17 10.2a2.4 2.4 0 1 0 0 3.6" />
    </svg>
  )
}

export function Frame({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" opacity="0.55" />
    </svg>
  )
}

export function Stop({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}
