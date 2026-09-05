/**
 * s7-execution Scenario 10 — NDJSON line framing, and every ugly case it has.
 *
 * This file does exactly one thing: turn a stream of arbitrary chunks into
 * whole lines. It knows nothing about JSON, nothing about the child protocol
 * and nothing about the wire. That separation is deliberate — the framing
 * bugs and the vocabulary bugs are different bugs, and a parser that mixes
 * them cannot be tested for either.
 *
 * The house already has this pattern twice: Sc 6's spawn transcript holds a
 * carry buffer so a `wm_<64 hex>` split across two chunks is still redacted,
 * and Sc 8's `createSseParser` holds one so a JSON body split across `data:`
 * lines is still parsed. The reason it keeps recurring is that a pipe has no
 * obligation to hand you a line: a chunk boundary can fall anywhere, and
 * every naive reader in the world has the same bug.
 *
 * The child protocol is a PUBLIC contract that a stranger implements in a
 * language we have never seen, so "what happens if" is not an edge case here,
 * it is the specification. Every answer below is a row in
 * `test/shim.spec.ts`:
 *
 *  - **A line split across chunks** is buffered and delivered once, whole.
 *    Splitting per character is the same code path as splitting once.
 *  - **CRLF** is a terminator plus noise. A single trailing `\r` is stripped
 *    before the line is handed on. A bare `\r` is NOT a terminator: NDJSON is
 *    newline-delimited, and treating a lone carriage return as a line break
 *    would silently split a body that legitimately contains one.
 *  - **Blank and whitespace-only lines** are skipped, not refused. They carry
 *    no message and no error, and a contract that punished a stray newline
 *    would be a contract nobody could implement in shell.
 *  - **A line past the budget** is refused ONCE and the framer then
 *    RESYNCHRONISES: everything up to the next newline belongs to the line
 *    already refused. This is the case a naive implementation gets wrong in
 *    the most damaging way — it truncates at the budget and emits the tail as
 *    a fresh line, turning one oversized input into a stream of plausible
 *    garbage. There is no partial delivery here, ever.
 *  - **A trailing line with no newline** is flushed by `end()` and marked
 *    `final`, because plenty of correct programs never terminate their last
 *    line and refusing a good answer over a missing byte is a bad trade. The
 *    caller decides what to do about a `final` line that does not parse; that
 *    is the "died mid-line" case, and it is a vocabulary question rather than
 *    a framing one.
 *  - **`end()` is idempotent** and invents nothing: a second call has no
 *    carry left to flush.
 */

/** What the framer produces. Never a partial line; never a guess. */
export type NdjsonEvent =
  | { readonly ok: true; readonly text: string; readonly final: boolean }
  | { readonly ok: false; readonly reason: 'oversize' };

export interface NdjsonParser {
  /** Feed a chunk. Returns whole lines, in order, plus any refusals. */
  push(chunk: string): NdjsonEvent[];
  /** End of stream. Flushes an unterminated final line if there is one. */
  end(): NdjsonEvent[];
}

/**
 * The default line ceiling, in characters.
 *
 * Deliberately the SAME number as the conformance kit's `maxFrameBytes`
 * (`DEFAULT_SPAWN_BUDGETS`, Sc 6). A shim whose child budget and whose wire
 * budget disagreed would accept a line it could never turn into a frame, and
 * the mismatch would surface as a confusing refusal one layer away from its
 * cause. One number, restated rather than imported: the kit is a dev
 * dependency of this package and must not become a runtime one.
 */
export const DEFAULT_MAX_LINE_BYTES = 262_144;

export function createNdjsonParser(
  maxLineBytes: number = DEFAULT_MAX_LINE_BYTES,
): NdjsonParser {
  /** Bytes of an incomplete line, waiting for their terminator. */
  let carry = '';
  /**
   * True while the framer is discarding the tail of a line it already
   * refused. This flag IS the resynchronisation: without it, an oversized
   * line's remainder becomes the next line.
   */
  let skipping = false;

  /** A complete raw line, minus its terminator, or `null` if it is noise. */
  const clean = (raw: string): string | null => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    return text.trim() === '' ? null : text;
  };

  return {
    push(chunk: string): NdjsonEvent[] {
      const out: NdjsonEvent[] = [];
      let data = chunk;
      while (data.length > 0) {
        if (skipping) {
          const nl = data.indexOf('\n');
          if (nl === -1) return out;
          skipping = false;
          data = data.slice(nl + 1);
          continue;
        }
        const nl = data.indexOf('\n');
        if (nl === -1) {
          carry += data;
          // No terminator in sight and already past the ceiling. Refuse now
          // rather than buffer an unbounded line: a child that never sends a
          // newline is otherwise a memory leak with a plausible excuse.
          if (carry.length > maxLineBytes) {
            out.push({ ok: false, reason: 'oversize' });
            carry = '';
            skipping = true;
          }
          return out;
        }
        const raw = carry + data.slice(0, nl);
        carry = '';
        data = data.slice(nl + 1);
        if (raw.length > maxLineBytes) {
          // The terminator was already consumed, so there is nothing to
          // resynchronise on: this line is refused and the next one is fine.
          out.push({ ok: false, reason: 'oversize' });
          continue;
        }
        const text = clean(raw);
        if (text !== null) out.push({ ok: true, text, final: false });
      }
      return out;
    },

    end(): NdjsonEvent[] {
      const raw = carry;
      carry = '';
      // The tail of a line we already refused is not a line. Flushing it
      // would deliver exactly the fragment the refusal existed to suppress.
      if (skipping) {
        skipping = false;
        return [];
      }
      if (raw.length > maxLineBytes) return [{ ok: false, reason: 'oversize' }];
      const text = clean(raw);
      return text === null ? [] : [{ ok: true, text, final: true }];
    },
  };
}
