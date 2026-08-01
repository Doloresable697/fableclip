import type { Word } from './types'

/** SRT timestamps are hh:mm:ss,mmm — comma, not a full stop. */
export function srtTime(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = Math.floor(clamped % 60)
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000)

  const pad = (n: number, width = 2): string => n.toString().padStart(width, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(Math.min(999, ms), 3)}`
}

/**
 * A sidecar subtitle file for the clip.
 *
 * Deliberately not the same grouping as the burned-in captions: those are
 * three or four words at a time because that is what reads on a phone, and a
 * .srt built the same way is 400 cues of two words each — unusable in an
 * editor and rejected by some upload flows. This groups into ordinary
 * subtitle lines.
 */
export function buildSrt(words: Word[], maxWords = 9, maxChars = 44): string {
  const cues: Word[][] = []
  let current: Word[] = []
  let chars = 0

  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue

    const previous = current[current.length - 1]
    if (previous) {
      const gap = word.t - (previous.t + previous.d)
      if (
        current.length >= maxWords ||
        chars + text.length + 1 > maxChars ||
        gap > 0.8 ||
        /[.!?]["')\]]?$/.test(previous.text)
      ) {
        cues.push(current)
        current = []
        chars = 0
      }
    }

    current.push({ ...word, text })
    chars += text.length + 1
  }

  if (current.length > 0) cues.push(current)

  return cues
    .map((cue, i) => {
      const last = cue[cue.length - 1]
      const start = cue[0].t
      const end = Math.max(last.t + last.d, start + 0.3)
      const text = cue.map((w) => w.text).join(' ')

      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`
    })
    .join('\n')
}
