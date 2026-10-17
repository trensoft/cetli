// SPDX-License-Identifier: GPL-3.0-or-later
// The preview of a note in the "All notes" list: its first lines, cut to a size the list can draw at once. No Gtk import,
// so that a test can check it without a display. A note can be 65536 bytes (MAX_TEXT_BYTES): only the head of the text is read.

export const PREVIEW_LINES = 3;
export const PREVIEW_LINE_CHARS = 80;        // code points per line; the label ellipsizes to the width of the window as well
const HEAD_CHARS = 800;                      // how much of the text is looked at at all

// At most `max` code points of `s` (an emoji is ONE; a cut never splits a surrogate pair), `…` after a cut line.
function cut(s, max) {
    const cps = Array.from(s);
    return cps.length <= max ? s : `${cps.slice(0, max).join('')}…`;
}

// The visible lines of the preview as ranges of the ORIGINAL text, in code points (the unit of the stored formatting marks):
// [{start, end, cut, chars}], `chars` the code points shown, `cut` when the line is longer than PREVIEW_LINE_CHARS (then `end` is
// where the line was cut). One place decides which text is shown, so that previewOf and previewMarkup cannot drift apart; only the
// head of the text is ever looked at.
function previewLines(text) {
    const whole = String(text ?? '');
    const trimmed = whole.trimStart();
    const lead = Array.from(whole.slice(0, whole.length - trimmed.length)).length;   // white space is BMP: the same in both units
    let head = trimmed.slice(0, HEAD_CHARS);                                           // blank lines before the text do not use up the head
    const last = head.charCodeAt(head.length - 1);
    if (last >= 0xd800 && last <= 0xdbff)
        head = head.slice(0, -1);                     // the cut fell inside a surrogate pair
    const out = [];
    let from = 0;
    const take = to => {
        const raw = head.slice(from, to);
        const line = raw.trim();
        if (line !== '') {
            const a = from + (raw.length - raw.trimStart().length);
            const start = lead + Array.from(head.slice(0, a)).length;
            const chars = Array.from(line);
            const shown = chars.slice(0, PREVIEW_LINE_CHARS);
            out.push({start, end: start + shown.length, cut: chars.length > PREVIEW_LINE_CHARS, chars: shown});
        }
        return out.length >= PREVIEW_LINES;
    };
    for (const m of head.matchAll(/\r\n|\r|\n/g)) {
        if (take(m.index))
            return out;
        from = m.index + m[0].length;
    }
    take(head.length);
    return out;
}

// Returns {text, empty}: the first PREVIEW_LINES non-blank lines, trimmed, one per line; `empty` when the note has no text
// at all (the caller shows its own placeholder, a translated text).
export function previewOf(text) {
    const lines = previewLines(text);
    return {text: lines.map(l => `${l.chars.join('')}${l.cut ? '…' : ''}`).join('\n'), empty: lines.length === 0};
}

const MARKUP_TAGS = [[8, 's'], [4, 'u'], [2, 'i'], [1, 'b']];    // the bits of the stored flags, innermost first: <b> is the outermost tag
const markupEscape = s => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'})[c]);
// a lone surrogate half in a text (it cannot be passed to a label as UTF-8; gjs 1.74 has no String.prototype.isWellFormed)
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// The preview of previewOf as a Pango markup string with the stored formatting (`ranges`: [[start, end, flags], ...] in code points
// of `text`, as decodeMarks answers), or null when the card is to be drawn as plain text (no usable range falls in the lines that
// are shown, or a shown line is not well-formed text). The text of the note is outside data: EVERY character that goes into the markup is
// escaped, only the four tags written here are markup. The cut is made before the ranges are laid on the lines, so a range that
// reaches past the cut is simply cut with its line, and every tag is closed at the end of its own line. The `…` of a cut line is
// plain. A range that is not [safe int, safe int, flags] is ignored; overlapping ranges are OR-ed. Never throws.
export function previewMarkup(text, ranges) {
    try {
        if (!Array.isArray(ranges) || ranges.length === 0)
            return null;
        const lines = previewLines(text);
        if (lines.some(l => LONE_SURROGATE.test(l.chars.join(''))))
            return null;
        let marked = false;
        const parts = lines.map(l => {
            const flags = new Array(l.end - l.start).fill(0);
            for (const r of ranges) {
                if (!Array.isArray(r) || !Number.isSafeInteger(r[0]) || !Number.isSafeInteger(r[1]) || !Number.isSafeInteger(r[2]))
                    continue;
                const f = r[2] & 15;
                for (let i = Math.max(r[0], l.start); i < Math.min(r[1], l.end); i++)
                    flags[i - l.start] |= f;
            }
            let html = '';
            for (let i = 0; i < flags.length;) {
                let j = i + 1;
                while (j < flags.length && flags[j] === flags[i])
                    j++;
                let run = markupEscape(l.chars.slice(i, j).join(''));
                for (const [bit, tag] of MARKUP_TAGS) {
                    if (flags[i] & bit)
                        run = `<${tag}>${run}</${tag}>`;
                }
                marked = marked || flags[i] !== 0;
                html += run;
                i = j;
            }
            return l.cut ? `${html}…` : html;
        });
        return marked ? parts.join('\n') : null;
    } catch {
        return null;
    }
}

// The search of the "All notes" window: the text of the note, lower-cased, holds the query, lower-cased. A query of white
// space only (or empty) matches every note.
export function matchesQuery(text, query) {
    const q = String(query ?? '').toLowerCase();
    if (q.replace(/\s/g, '') === '')
        return true;
    return String(text ?? '').toLowerCase().includes(q);
}

const two = n => String(n).padStart(2, '0');

// The time of the last change on a card: HH:MM when it was today (local time), else YYYY-MM-DD. `iso` is the `updated` of the
// record; an unreadable one gives ''.
export function timeLabel(iso, now = new Date()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return '';
    const day = x => `${x.getFullYear()}-${two(x.getMonth() + 1)}-${two(x.getDate())}`;
    return day(d) === day(now) ? `${two(d.getHours())}:${two(d.getMinutes())}` : day(d);
}
