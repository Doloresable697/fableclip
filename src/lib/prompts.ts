import type { ChatMessage, JobOptions } from './types'
import type { Window } from './transcript'
import { renderWindow } from './transcript'

/**
 * What the model is for, and what it is not for.
 *
 * It is not asked for timestamps. Every segment carries an integer id and the
 * model points at ids — a small model asked for "01:42:17" invents one, and
 * an invented timestamp is a clip of the wrong moment rather than an error.
 *
 * It is also not asked for a single "virality score". A model given one number
 * to fill in returns 7 or 8 for everything. Six named judgements, each with a
 * stated meaning, produce answers that actually differ between passages — and
 * the weighting is arithmetic, done here, where it can be tested.
 */
export const SYSTEM = `You find the moments in a long talk that work as standalone short videos.

You are given a numbered transcript. Every line looks like:

[41] and that is when the whole thing fell apart

The number is the line's id. You refer to moments ONLY by id. Never write a
timestamp — you cannot see the clock and any time you write down will be wrong.

A moment worth clipping:
- opens on a line that makes a stranger stay: a claim, a question, a number, a refusal
- is understandable with zero context — no "as I said", no unexplained "he" or "it"
- goes somewhere and lands, rather than stopping mid-thought
- contains at least one line somebody would screenshot

A moment NOT worth clipping:
- introductions, thanks, housekeeping, sign-offs
- a setup with the payoff outside the range you picked
- a list of caveats, or an answer that never arrives
- anything that only makes sense if you watched the preceding ten minutes

Score each candidate on six axes, 0-10, honestly. A flat transcript should get
low numbers. Inflating everything to 8 makes the ranking useless:

- hook:        does the FIRST line make someone stop scrolling?
- emotion:     surprise, anger, delight, tension, conviction — any of it
- clarity:     can a stranger follow it cold?
- payoff:      does it resolve, land, or conclude?
- quotability: is there one sentence worth screenshotting?
- novelty:     is the claim non-obvious?

Reply with JSON only, no prose around it:

{"clips":[{"startId":41,"endId":58,"title":"Six words, no clickbait","hook":"the one line that earns the watch","reason":"one sentence on why this travels","startQuote":"first five words of line 41","endQuote":"last five words of line 58","scores":{"hook":8,"emotion":6,"clarity":9,"payoff":7,"quotability":8,"novelty":5}}]}`

export function findClipsPrompt(
  window: Window,
  options: JobOptions,
  want: number,
): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        `Find up to ${want} clippable moments in this transcript.\n\n` +
        `Each must run about ${options.minSeconds}-${options.maxSeconds} seconds ` +
        `of speech — roughly ${Math.round(options.minSeconds * 2.4)} to ` +
        `${Math.round(options.maxSeconds * 2.4)} words, so a handful of lines, ` +
        `not one and not forty.\n\n` +
        `Pick different moments from each other. Two clips covering the same ` +
        `idea is one clip.\n\n` +
        `Transcript:\n\n${renderWindow(window)}`,
    },
  ]
}

/**
 * A second pass, only for clips whose opening cannot stand alone.
 *
 * Detecting a dangling opener is arithmetic (see score.ts); rewriting one is
 * not. This asks for a title and hook that carry the missing context, which is
 * the difference between "and that's the problem" and a clip somebody watches.
 */
export function retitlePrompt(text: string, context: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You write titles for short videos. Six to nine words, no clickbait, ' +
        'no emoji, no "you won\'t believe". State what actually happens. ' +
        'Reply with JSON only: {"title":"...","hook":"..."}',
    },
    {
      role: 'user',
      content:
        `This clip is being posted with no surrounding context.\n\n` +
        `What comes just before it: ${context}\n\n` +
        `The clip itself: ${text}\n\n` +
        `Write a title, and a one-line hook that supplies the missing context.`,
    },
  ]
}
