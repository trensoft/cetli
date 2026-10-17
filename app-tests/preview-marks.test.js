// SPDX-License-Identifier: GPL-3.0-or-later
// The formatted preview of a card in "All notes" (0.2.2): previewMarkup, the pure part (no Gtk). The glue with Gtk is checked by
// preview-marks-smoke.js. The invariant under everything: the text of the markup, read back, IS the plain preview.
import test from 'node:test';
import assert from 'node:assert/strict';

import {PREVIEW_LINES, PREVIEW_LINE_CHARS, previewMarkup, previewOf} from '../app/preview.js';

const B = 1;
const I = 2;
const U = 4;
const S = 8;

// What a reader of the markup sees: per line, a list of [character, flags]. A strict little parser: only <b> <i> <u> <s> are markup,
// the five entities are the only escapes, any other '<' '>' '&' fails.
function readBack(markup) {
    return markup.split('\n').map(line => {
        const out = [];
        let flags = 0;
        const stack = [];
        for (let i = 0; i < line.length;) {
            const ch = line[i];
            if (ch === '<') {
                const m = /^<(\/?)([bius])>/.exec(line.slice(i));
                assert.ok(m, `unknown markup at ${i} of ${JSON.stringify(line)}`);
                const bit = {b: B, i: I, u: U, s: S}[m[2]];
                if (m[1] === '') {
                    stack.push(m[2]);
                    flags |= bit;
                } else {
                    assert.equal(stack.pop(), m[2], `tags nest in ${JSON.stringify(line)}`);
                    flags &= ~bit;
                }
                i += m[0].length;
            } else if (ch === '&') {
                const m = /^&(amp|lt|gt|quot|apos);/.exec(line.slice(i));
                assert.ok(m, `bare & at ${i} of ${JSON.stringify(line)}`);
                out.push([{amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}[m[1]], flags]);
                i += m[0].length;
            } else {
                assert.notEqual(ch, '>', `bare > in ${JSON.stringify(line)}`);
                const cp = String.fromCodePoint(line.codePointAt(i));
                out.push([cp, flags]);
                i += cp.length;
            }
        }
        assert.equal(stack.length, 0, `every tag is closed at the end of its line ${JSON.stringify(line)}`);
        return out;
    });
}
const textOf = markup => readBack(markup).map(l => l.map(c => c[0]).join('')).join('\n');

test('preview markup: no usable range on the shown lines is null (the card stays plain)', () => {
    assert.equal(previewMarkup('hello', []), null);
    assert.equal(previewMarkup('hello', null), null);
    assert.equal(previewMarkup('hello', undefined), null);
    assert.equal(previewMarkup('hello', 'x'), null);
    assert.equal(previewMarkup('', [[0, 1, B]]), null);
    assert.equal(previewMarkup('a\nb\nc\nd', [[6, 7, B]]), null, 'only the 4th line is formatted: not shown');
    assert.equal(previewMarkup('hello', [[10, 20, B]]), null, 'a range behind the text');
    assert.equal(previewMarkup('  \n  hello', [[0, 3, B]]), null, 'a range over blanks that are not shown');
});

test('preview markup: each flag is its own tag, in a fixed nesting', () => {
    assert.equal(previewMarkup('hello world', [[0, 5, B]]), '<b>hello</b> world');
    assert.equal(previewMarkup('hello world', [[0, 5, I]]), '<i>hello</i> world');
    assert.equal(previewMarkup('hello world', [[0, 5, U]]), '<u>hello</u> world');
    assert.equal(previewMarkup('hello world', [[0, 5, S]]), '<s>hello</s> world');
    assert.equal(previewMarkup('hello world', [[6, 11, B | I | U | S]]), 'hello <b><i><u><s>world</s></u></i></b>');
    assert.equal(previewMarkup('hello world', [[0, 11, B]]), '<b>hello world</b>');
});

test('preview markup: offsets are code points of the whole text (an emoji is one; blanks and lines before the text count)', () => {
    assert.equal(previewMarkup('\u{1F600}\u{1F600}ab', [[2, 4, B]]), '\u{1F600}\u{1F600}<b>ab</b>', 'not UTF-16 units');
    assert.equal(previewMarkup('ab\u{1F600}cd', [[3, 5, I]]), 'ab\u{1F600}<i>cd</i>');
    assert.equal(previewMarkup('\n\n  hello world', [[4, 9, B]]), '<b>hello</b> world', 'leading blank lines and indentation are not shown but count');
    assert.equal(previewMarkup('one\ntwo', [[4, 7, I]]), 'one\n<i>two</i>');
    assert.equal(previewMarkup('ab\u{1F600}\ncd', [[4, 6, B]]), 'ab\u{1F600}\n<b>cd</b>', 'an emoji on an earlier line is one code point');
    assert.equal(previewMarkup('one\r\ntwo', [[5, 8, I]]), 'one\n<i>two</i>', 'CRLF is two code points');
    assert.equal(previewMarkup('one\rtwo\rthree', [[8, 13, B]]), 'one\ntwo\n<b>three</b>', 'CR alone is a line end');
    assert.equal(previewMarkup('  ab  \n cd ', [[0, 11, B]]), '<b>ab</b>\n<b>cd</b>', 'trimmed blanks stay outside the tags');
    assert.equal(previewMarkup('a\n\n\nb', [[4, 5, B]]), 'a\n<b>b</b>', 'blank lines are skipped, the offset still counts them');
    assert.equal(previewMarkup(`${'\n'.repeat(5000)}late`, [[5000, 5004, B]]), '<b>late</b>', 'the head is read from the first non-blank character');
});

test('preview markup: the head is cut in UTF-16 units (800) and the offsets are mapped back in code points', () => {
    const e = '\u{1F600}';
    // line 2 is the one the head reaches into: 790 + 1 units, then 9 characters of line 2 are inside the 800
    const head = `${'x'.repeat(790)}\nabcdefghij`;
    assert.equal(previewMarkup(head, [[791, 801, B]]), `${'x'.repeat(80)}…\n<b>abcdefghi</b>`, 'the range is cut where the head is cut');
    assert.equal(previewOf(head).text, `${'x'.repeat(80)}…\nabcdefghi`, 'the same lines as the plain preview');
    assert.equal(previewMarkup(head, [[800, 801, B]]), null, 'a range behind the head: nothing of it is shown');
    // the cut falls inside an emoji: the half pair is dropped, the range over the emoji is not shown
    const split = `${'x'.repeat(789)}\nabcdefghi${e}j`;
    assert.equal(previewMarkup(split, [[790, 801, B]]), `${'x'.repeat(80)}…\n<b>abcdefghi</b>`);
    assert.equal(previewMarkup(split, [[799, 800, B]]), null, 'the emoji itself is behind the cut');
    // emoji before the head limit make the code point offsets smaller than the UTF-16 ones: 300 emoji are 600 units
    const wide = `${e.repeat(300)}\nabcdef`;
    assert.equal(previewMarkup(wide, [[301, 304, I]]), `${e.repeat(80)}…\n<i>abc</i>def`);
    assert.equal(previewMarkup(wide, [[60, 62, I]]), `${e.repeat(60)}<i>${e.repeat(2)}</i>${e.repeat(18)}…\nabcdef`);
    // the head holds an emoji on each of three lines; the third is cut by the head, not by the 80 limit
    const three = `${e.repeat(150)}\n${e.repeat(150)}\n${e.repeat(150)}\n${e}`;
    assert.equal(previewMarkup(three, [[302, 304, B]]), `${e.repeat(80)}…\n${e.repeat(80)}…\n<b>${e.repeat(2)}</b>${e.repeat(78)}…`);
});

test('preview markup: trimmed blanks and line ends map back (indent with emoji after it, CRLF, tabs, a line of blanks)', () => {
    const e = '\u{1F600}';
    assert.equal(previewMarkup(`  \t${e}ab  \t`, [[0, 6, B]]), `<b>${e}ab</b>`, 'blanks are outside, the emoji is one code point');
    assert.equal(previewMarkup(`  \t${e}ab  \t`, [[3, 4, B]]), `<b>${e}</b>ab`);
    assert.equal(previewMarkup(`${e}\r\n  \r\n \t ${e}x`, [[10, 11, I]]), `${e}\n<i>${e}</i>x`, 'CRLF is two, the line of blanks counts and is skipped');
    assert.equal(previewMarkup(`${e} \n${e}`, [[1, 2, B]]), null, 'a range over the trimmed blank only is not shown');
    assert.equal(previewMarkup(`${e} \n${e}`, [[1, 4, B]]), `${e}\n<b>${e}</b>`, 'a range over a trimmed blank is cut to the shown part');
    assert.equal(previewMarkup(`${'\u3000'}${e}a`, [[1, 3, U]]), `<u>${e}a</u>`, 'a wide blank in front is trimmed and counts one');
});

test('preview markup: a range over a line end is closed on each line; ranges overlap with OR', () => {
    assert.equal(previewMarkup('ab\ncd', [[1, 4, B]]), 'a<b>b</b>\n<b>c</b>d');
    assert.equal(previewMarkup('abcde', [[0, 3, B], [2, 5, I]]), '<b>ab</b><b><i>c</i></b><i>de</i>');
    assert.equal(previewMarkup('abcde', [[2, 5, I], [0, 3, B]]), '<b>ab</b><b><i>c</i></b><i>de</i>', 'order does not matter');
    assert.equal(previewMarkup('abcdef', [[0, 2, B], [2, 4, B], [4, 6, I]]), '<b>abcd</b><i>ef</i>', 'touching equal flags are one tag');
});

test('preview markup: the cut. A formatted range is cut with its line; the ellipsis is plain; the line limit counts characters, not entities', () => {
    const long = 'x'.repeat(100);
    assert.equal(previewMarkup(long, [[70, 100, B]]), `${'x'.repeat(70)}<b>${'x'.repeat(10)}</b>…`);
    assert.equal(previewMarkup(long, [[0, 100, B]]), `<b>${'x'.repeat(PREVIEW_LINE_CHARS)}</b>…`);
    assert.equal(previewMarkup(long, [[85, 95, B]]), null, 'the formatting is behind the cut: nothing of it is shown');
    assert.equal(previewMarkup('x'.repeat(PREVIEW_LINE_CHARS), [[0, PREVIEW_LINE_CHARS, B]]), `<b>${'x'.repeat(PREVIEW_LINE_CHARS)}</b>`, 'a line of exactly the limit has no ellipsis');
    const amps = previewMarkup('&'.repeat(200), [[0, 200, B]]);
    assert.equal(Array.from(textOf(amps)).length, PREVIEW_LINE_CHARS + 1, 'the same 80 characters as the plain preview, not 80 entities');
    assert.equal(textOf(amps), previewOf('&'.repeat(200)).text);
    const emoji = previewMarkup('\u{1F600}'.repeat(100), [[0, 100, B]]);
    assert.equal(emoji, `<b>${'\u{1F600}'.repeat(PREVIEW_LINE_CHARS)}</b>…`, 'a cut never splits an emoji');
    assert.equal(previewMarkup('a\nb\nc\nd', [[0, 7, B]]), '<b>a</b>\n<b>b</b>\n<b>c</b>', `only ${PREVIEW_LINES} lines`);
    // 64 KB of text, 256 ranges
    const big = 'line of text\n'.repeat(5000);
    const ranges = Array.from({length: 256}, (_, i) => [i * 3, i * 3 + 2, 1 + (i % 15)]);
    const t0 = process.hrtime.bigint();
    const m = previewMarkup(big, ranges);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(m.startsWith('<b>li</b>'), m.slice(0, 40));
    assert.ok(ms < 50, `64 KB with 256 ranges in ${ms.toFixed(2)} ms`);
});

test('preview markup: the text of the note is DATA - every character is escaped, only the four tags are markup', () => {
    const hostile = [
        '<b>not bold</b> & <span foreground="red">red</span>',
        '&amp; &#0; &#x41; &lt;i&gt; ]]> <!-- --> <?pi?> <![CDATA[x]]>',
        '"quotes" and \'apostrophes\' \\ <> ><',
        '<span size="999999999">big</span><big>b</big><sub>s</sub><tt>t</tt><markup>',
    ];
    for (const t of hostile) {
        const m = previewMarkup(t, [[0, Array.from(t).length, B]]);
        assert.notEqual(m, null);
        assert.equal(textOf(m), previewOf(t).text.replace(/…$/, ''), `reads back as the plain text: ${t}`);
        assert.ok(!/<(?!\/?[bius]>)/.test(m), `no tag but the four: ${m}`);
        const half = previewMarkup(t, [[2, 6, I]]);
        assert.equal(textOf(half).replace(/…$/, ''), previewOf(t).text.replace(/…$/, ''));
    }
    assert.equal(previewMarkup('a<b', [[0, 3, B]]), '<b>a&lt;b</b>');
    assert.equal(previewMarkup('a&b', [[1, 2, B]]), 'a<b>&amp;</b>b');
    assert.equal(previewMarkup('<i>x</i>', [[0, 8, B]]), '<b>&lt;i&gt;x&lt;/i&gt;</b>', 'a typed tag is shown as typed');
});

test('preview markup: odd ranges and odd texts are ignored or plain; it never throws', () => {
    assert.equal(previewMarkup('abc', [[0.5, 2, B]]), null, 'a fraction');
    assert.equal(previewMarkup('abc', [['0', 2, B]]), null, 'a string offset');
    assert.equal(previewMarkup('abc', [[0, 2, '1']]), null, 'a string flag');
    assert.equal(previewMarkup('abc', [null, 'x', 5, [0, 2], {}]), null);
    assert.equal(previewMarkup('abc', [[0, 2, 0]]), null, 'flags 0 is no formatting');
    assert.equal(previewMarkup('abc', [[0, 2, 16]]), null, 'flags outside the four bits');
    assert.equal(previewMarkup('abc', [[0, 2, 17]]), '<b>ab</b>c', 'only the known bits are used');
    assert.equal(previewMarkup('abc', [[NaN, 2, B], [Infinity, 3, B], [0, Infinity, B], [-5, 2, B]]), '<b>ab</b>c', 'a negative start is cut to 0; a non-finite one is ignored');
    assert.equal(previewMarkup('abc', [[2, 1, B]]), null, 'end before start');
    assert.equal(previewMarkup('ab\ud83dc', [[0, 4, B]]), null, 'a lone surrogate in the text: plain');
    assert.equal(previewMarkup('\ude00ab', [[0, 3, B]]), null);
    assert.equal(previewMarkup(undefined, [[0, 1, B]]), null);
    assert.equal(previewMarkup(null, [[0, 1, B]]), null);
    assert.equal(previewMarkup(12345, [[0, 2, B]]), '<b>12</b>345');
    const trap = new Proxy([[0, 1, B]], {get() { throw new Error('hostile'); }});
    assert.equal(previewMarkup('abc', trap), null);
    const huge = Array.from({length: 100000}, () => [0, 3, B]);
    assert.equal(previewMarkup('abc', huge), '<b>abc</b>');
});

// ---- the old preview must not change: previewOf is now made from the same line finder as the markup ------------------------

// The previewOf of 0.2.1 (cetli-022-list/app/preview.js), word for word.
function oldPreviewOf(text) {
    const cut = (s, max) => {
        const cps = Array.from(s);
        return cps.length <= max ? s : `${cps.slice(0, max).join('')}…`;
    };
    let head = String(text ?? '').trimStart().slice(0, 800);
    const last = head.charCodeAt(head.length - 1);
    if (last >= 0xd800 && last <= 0xdbff)
        head = head.slice(0, -1);
    const lines = head.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l !== '').slice(0, 3);
    return {text: lines.map(l => cut(l, 80)).join('\n'), empty: lines.length === 0};
}

let seed = 20261017;
const rnd = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
};
const PIECES = ['a', 'b', 'x', ' ', ' ', '\t', '\n', '\n', '\r', '\r\n', ' ', ' ', '﻿', '　', '\u{1F600}', 'é', '<', '&', '"', "'", '\ud83d', '\ude00', 'word ', 'x'.repeat(30)];
const randomText = () => Array.from({length: rnd(70)}, () => PIECES[rnd(PIECES.length)]).join('');

test('preview markup: previewOf is exactly the 0.2.1 previewOf (fixed cases and 3000 random texts)', () => {
    const fixed = ['', ' ', '\n\n', undefined, null, 'a', '  a  ', 'a\r\nb\rc\nd', `${'\n'.repeat(900)}x`, 'x'.repeat(5000), '\u{1F389}'.repeat(900),
        `${'x'.repeat(400)}\n${'y'.repeat(397)}\n\u{1F389}z`, `${'x'.repeat(799)}\u{1F389}`, `${' '.repeat(900)}x`, ' a b', 'a \nb '];
    for (const t of fixed)
        assert.deepEqual(previewOf(t), oldPreviewOf(t), JSON.stringify(t)?.slice(0, 60));
    for (let n = 0; n < 3000; n++) {
        const t = randomText();
        assert.deepEqual(previewOf(t), oldPreviewOf(t), JSON.stringify(t));
    }
});

test('preview markup: 3000 random texts with random ranges - it reads back as the plain preview, tags nest, and the flags are the ranges\'', () => {
    for (let n = 0; n < 3000; n++) {
        const t = randomText();
        if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t))
            continue;
        const len = Array.from(t).length;
        const ranges = Array.from({length: rnd(6)}, () => {
            const s = rnd(len + 3);
            return [s, s + 1 + rnd(len + 3 - s + 1), 1 + rnd(15)];
        });
        const m = previewMarkup(t, ranges);
        const plain = previewOf(t).text;
        if (m === null)
            continue;
        const back = readBack(m);
        assert.equal(textOf(m), plain, `reads back as the plain preview of ${JSON.stringify(t)}`);
        // every shown character has the flags the ranges give its own offset in the text
        const want = new Array(len).fill(0);
        for (const [s, e, f] of ranges) {
            for (let i = s; i < Math.min(e, len); i++)
                want[i] |= f;
        }
        let from = 0;                                // code unit where the search for the next line goes on
        back.forEach((line, k) => {
            const shown = plain.split('\n')[k];
            const body = line.slice(0, shown.endsWith('…') ? -1 : line.length);   // the texts of this test have no '…' of their own
            const at = t.indexOf(body.map(c => c[0]).join(''), from);
            assert.ok(at >= 0, `the line ${k} is in the text`);
            const startCp = Array.from(t.slice(0, at)).length;
            body.forEach((c, i) => assert.equal(c[1], want[startCp + i], `flags of ${JSON.stringify(c[0])} at ${startCp + i} in ${JSON.stringify(t)} with ${JSON.stringify(ranges)}`));
            if (shown.endsWith('…'))
                assert.equal(line[line.length - 1][1], 0, 'the ellipsis is plain');
            from = at + body.map(c => c[0]).join('').length;
        });
    }
});
