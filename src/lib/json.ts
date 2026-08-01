/**
 * Pull the JSON value out of model output.
 *
 * Small local models fence their JSON, narrate before it, sometimes show an
 * example schema first, and chatter after it. So rather than special-casing
 * markdown fences — which is what made an example block win over the real
 * answer — we scan the whole text for every balanced JSON value and return
 * the LAST one that parses. Decoys are skipped, not fatal: prose such as
 * "use {curly} braces" balances but does not parse, so the scan moves on.
 */
export function extractJson<T = unknown>(text: string): T {
  let found: { value: unknown } | null = null
  let sawUnterminated = false
  let cursor = 0

  while (cursor < text.length) {
    const start = findOpener(text, cursor)
    if (start === -1) break

    const end = scanBalanced(text, start)
    if (end === -1) {
      sawUnterminated = true
      break
    }

    try {
      found = { value: JSON.parse(text.slice(start, end + 1)) }
    } catch {
      // A decoy such as `{curly}`. Keep looking.
    }

    cursor = end + 1
  }

  if (found) return found.value as T

  // Nothing balanced parsed. Before giving up, try closing what the model
  // left open — a 7B model gets the content right and the punctuation wrong
  // often enough that refusing here means refusing a usable answer.
  const repaired = repairJson(text)
  if (repaired !== null) return repaired as T

  if (sawUnterminated) throw new Error('Unterminated JSON in model output')
  throw new Error('No JSON object found in model output')
}

/**
 * Close brackets the model forgot, and only that.
 *
 * Two failures account for nearly all malformed model JSON, and both are
 * punctuation rather than content:
 *
 *   1. The response is cut off mid-value, leaving everything open at the end.
 *   2. A closer arrives in the wrong order — `..."brief": "x" ] }` where the
 *      object's own `}` was skipped. Observed from qwen2.5-coder:7b on the
 *      outline call.
 *
 * Both are repaired by the same rule: whenever a closer does not match what is
 * actually open, close the open things first; at the end, close what remains.
 * Nothing is invented, no value is edited, and the result still has to parse —
 * if it doesn't, this returns null and the caller reports the failure.
 */
export function repairJson(text: string): unknown | null {
  const start = findOpener(text, 0)
  if (start === -1) return null

  const out: string[] = []
  const stack: string[] = []
  let inString = false
  let escaped = false
  let i = start

  for (; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      out.push(ch)
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      out.push(ch)
      continue
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch)
      out.push(ch)
      continue
    }

    if (ch === '}' || ch === ']') {
      const wanted = ch === '}' ? '{' : '['
      // Close anything opened more recently than the thing this closer ends.
      while (stack.length > 0 && stack[stack.length - 1] !== wanted) {
        out.push(stack.pop() === '{' ? '}' : ']')
      }
      if (stack.length === 0) {
        // A closer with nothing open: the value ended here. Stop, and let
        // any trailing narration be ignored.
        break
      }
      stack.pop()
      out.push(ch)
      if (stack.length === 0) break
      continue
    }

    out.push(ch)
  }

  if (inString) out.push('"')

  // A cut-off response often ends on a dangling comma or a half-written key.
  let body = out.join('').replace(/,\s*$/, '')
  while (stack.length > 0) {
    body += stack.pop() === '{' ? '}' : ']'
  }
  body = body.replace(/,(\s*[}\]])/g, '$1')

  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function findOpener(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') return i
  }
  return -1
}

/** Index of the matching close bracket, or -1 if the value never terminates. */
function scanBalanced(text: string, start: number): number {
  const opener = text[start]
  const closer = opener === '{' ? '}' : ']'

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (inString && ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === opener) {
      depth++
    } else if (ch === closer) {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}
