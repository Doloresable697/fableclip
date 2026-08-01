import type { CaptionStyle, Word } from './types'

export interface CaptionPreset {
  /** Family name as the font file declares it — libass matches on this. */
  font: string
  /** File in assets/fonts, so the render does not depend on system fonts. */
  file: string
  /** Point size at 1920px tall. Scaled for other heights. */
  size: number
  /** Resting word colour, #RRGGBB. */
  primary: string
  /** The word being spoken. */
  active: string
  /**
   * Numbers, held in a second accent for the whole line.
   *
   * "$600 AN OUNCE" is the part somebody screenshots, and the karaoke
   * highlight only reaches it for a third of a second. Holding specifics in
   * their own colour means the eye finds them before the highlight does.
   */
  specific: string
  outline: string
  outlineWidth: number
  shadow: number
  wordsPerLine: number
  maxChars: number
  uppercase: boolean
  /** Distance from the bottom edge at 1920px tall. */
  marginV: number
}

/**
 * Four looks, and none of them resize the active word.
 *
 * Scaling the word being spoken is the obvious way to build this and it is
 * wrong: ASS lays the line out from scratch every frame, so a wider active
 * word shoves every word after it sideways and the whole caption twitches for
 * the length of the clip. Colour change alone carries the same read-along
 * effect and holds still.
 */
export const PRESETS: Record<Exclude<CaptionStyle, 'none'>, CaptionPreset> = {
  punch: {
    font: 'Anton',
    file: 'Anton-Regular.ttf',
    size: 88,
    primary: '#FFFFFF',
    active: '#FFE04D',
    specific: '#FF9E4D',
    outline: '#000000',
    outlineWidth: 6,
    shadow: 3,
    wordsPerLine: 4,
    maxChars: 26,
    uppercase: true,
    marginV: 430,
  },
  clean: {
    font: 'Poppins ExtraBold',
    file: 'Poppins-ExtraBold.ttf',
    size: 68,
    primary: '#FFFFFF',
    active: '#7CE38B',
    specific: '#6FD4E8',
    outline: '#101014',
    outlineWidth: 5,
    shadow: 2,
    wordsPerLine: 5,
    maxChars: 30,
    uppercase: false,
    marginV: 400,
  },
  chunky: {
    font: 'Lilita One',
    file: 'LilitaOne-Regular.ttf',
    size: 96,
    primary: '#FFFFFF',
    active: '#FF7A4D',
    specific: '#FFD24D',
    outline: '#000000',
    outlineWidth: 8,
    shadow: 0,
    wordsPerLine: 3,
    maxChars: 20,
    uppercase: true,
    marginV: 450,
  },
  condensed: {
    font: 'Bebas Neue',
    file: 'BebasNeue-Regular.ttf',
    size: 104,
    primary: '#FFFFFF',
    active: '#66C7FF',
    specific: '#FFD24D',
    outline: '#000000',
    outlineWidth: 5,
    shadow: 2,
    wordsPerLine: 5,
    maxChars: 28,
    uppercase: true,
    marginV: 420,
  },
}

/**
 * Words nobody wants to read.
 *
 * They stay in the audio — cutting individual filler words out of a sentence
 * sounds worse than leaving them in — but a caption that says
 * "A SECURITY UH MECHANISM" is just a transcription error on screen. Each word
 * carries its own timing, so dropping one from the line costs nothing.
 */
const CAPTION_FILLER = new Set(['um', 'uh', 'erm', 'uhh', 'umm', 'mm', 'mmm', 'hmm', 'ah', 'er'])

const isFiller = (text: string): boolean =>
  CAPTION_FILLER.has(text.toLowerCase().replace(/[^\p{L}]/gu, ''))

/** A number, a percentage or a sum of money — the thing people screenshot. */
export const isSpecific = (text: string): boolean => /\d/.test(text)

/**
 * ASS writes colours as &HAABBGGRR — alpha first, then blue, green, red.
 * Getting the byte order wrong turns a yellow highlight blue, which is the
 * kind of bug that survives review because both look deliberate.
 */
export function bgrColor(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').trim()
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6)

  const r = full.slice(0, 2)
  const g = full.slice(2, 4)
  const b = full.slice(4, 6)
  const a = Math.min(255, Math.max(0, Math.round(alpha)))
    .toString(16)
    .padStart(2, '0')

  return `&H${a}${b}${g}${r}`.toUpperCase()
}

/** ASS timestamps are h:mm:ss.cc — one hour digit, two centisecond digits. */
export function assTime(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = Math.floor(clamped % 60)
  const cs = Math.floor((clamped - Math.floor(clamped)) * 100)

  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`
}

/**
 * Text that cannot be mistaken for markup.
 *
 * `{` opens an override block in ASS, so a transcript containing "{" would
 * silently swallow the rest of the line — and a word ending in "\" would eat
 * the next character. Newlines become the explicit `\N` break.
 */
export function escapeAss(text: string): string {
  return text
    .replace(/\\/g, '∖')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/[\r\n]+/g, '\\N')
    // Control characters have no glyph and confuse the parser.
    .replace(/[\u0000-\u001f\u007f]/g, '')
}

export interface CaptionLine {
  words: Word[]
  start: number
  end: number
}

/**
 * Group words into the lines that appear on screen together.
 *
 * A line ends for any of four reasons: it is full by word count, it is full by
 * width, the sentence ended, or the speaker paused. The pause rule is what
 * stops a line from hanging on screen through three seconds of silence and
 * then flashing past — without it, timing driven purely by word count drifts
 * out of sync with how the speech actually sounds.
 */
export function toLines(
  words: Word[],
  preset: CaptionPreset,
  pauseSeconds = 0.7,
): CaptionLine[] {
  const lines: CaptionLine[] = []
  let current: Word[] = []
  let chars = 0

  const flush = (): void => {
    if (current.length === 0) return
    const last = current[current.length - 1]
    lines.push({
      words: current,
      start: current[0].t,
      end: Math.max(last.t + last.d, current[0].t + 0.2),
    })
    current = []
    chars = 0
  }

  for (const word of words) {
    const text = word.text.trim()
    if (!text || isFiller(text)) continue

    const previous = current[current.length - 1]
    if (previous) {
      const gap = word.t - (previous.t + previous.d)
      const wouldOverflow =
        current.length >= preset.wordsPerLine ||
        chars + text.length + 1 > preset.maxChars

      if (wouldOverflow || gap > pauseSeconds || /[.!?]["')\]]?$/.test(previous.text)) {
        flush()
      }
    }

    current.push({ ...word, text })
    chars += text.length + 1
  }

  flush()
  return balance(lines, preset)
}

/**
 * Stop a line ending with one word stranded on its own.
 *
 * Grouping greedily leaves an orphan whenever a sentence has one word more
 * than a whole number of lines — "THE WHOLE THING FELL" / "APART". Moving one
 * word back from the previous line reads better and costs a line nothing,
 * because the previous line is by definition not full.
 */
export function balance(lines: CaptionLine[], preset: CaptionPreset): CaptionLine[] {
  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1]
    const line = lines[i]

    if (line.words.length !== 1 || previous.words.length < 3) continue

    const moved = previous.words[previous.words.length - 1]
    const width = moved.text.length + 1 + line.words[0].text.length
    if (width > preset.maxChars) continue

    previous.words = previous.words.slice(0, -1)
    line.words = [moved, ...line.words]

    previous.end = previous.words[previous.words.length - 1].t + previous.words[previous.words.length - 1].d
    line.start = moved.t
  }

  return lines
}

export interface AssOptions {
  width: number
  height: number
  preset: CaptionPreset
}

/**
 * The subtitle file, as one Dialogue event per word.
 *
 * libass has a karaoke primitive (`\k`), and it is not used here: its
 * behaviour differs between builds and it cannot change a word's colour
 * without also owning the line's timing. Emitting the whole line once per word
 * — with that word coloured — is more events and completely predictable, which
 * is the right trade for something that renders unattended.
 */
export function buildAss(words: Word[], options: AssOptions): string {
  const { preset, width, height } = options

  // Every dimension in the preset is quoted at 1920 tall, so a 16:9 render
  // gets the same caption proportionally rather than a caption sized for a
  // phone floating in the middle of a landscape frame.
  const scale = height / 1920
  const size = Math.round(preset.size * scale)
  const marginV = Math.round(preset.marginV * scale)
  const outline = Math.max(1, Math.round(preset.outlineWidth * scale))
  const shadow = Math.round(preset.shadow * scale)
  const sideMargin = Math.round(width * 0.06)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    // 0 wraps evenly across lines; the line breaks are already decided here,
    // so this only matters for a single word too wide for the frame.
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, ' +
      'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ' +
      'ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, ' +
      'MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${preset.font},${size},${bgrColor(preset.primary)},` +
      `${bgrColor(preset.active)},${bgrColor(preset.outline)},` +
      `${bgrColor('#000000', 160)},0,0,0,0,100,100,0,0,1,${outline},${shadow},` +
      `2,${sideMargin},${sideMargin},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  const activeTag = `{\\c${bgrColor(preset.active)}}`
  const specificTag = `{\\c${bgrColor(preset.specific)}}`
  const resetTag = '{\\r}'
  const events: string[] = []

  for (const line of toLines(words, preset)) {
    for (let i = 0; i < line.words.length; i++) {
      const start = line.words[i].t
      // Hold each word until the next one begins, so the highlight moves
      // continuously instead of blinking off in the gaps between words.
      const end =
        i + 1 < line.words.length ? line.words[i + 1].t : line.end

      if (end - start < 0.02) continue

      const text = line.words
        .map((word, j) => {
          const shown = escapeAss(
            preset.uppercase ? word.text.toUpperCase() : word.text,
          )
          // The spoken word always wins the colour; a number only keeps its
          // accent while it is not the one being said.
          if (j === i) return `${activeTag}${shown}${resetTag}`
          return isSpecific(word.text) ? `${specificTag}${shown}${resetTag}` : shown
        })
        .join(' ')

      events.push(
        `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`,
      )
    }
  }

  return `${[...header, ...events].join('\n')}\n`
}

export function presetFor(style: CaptionStyle): CaptionPreset | null {
  return style === 'none' ? null : PRESETS[style]
}
