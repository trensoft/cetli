// SPDX-License-Identifier: GPL-3.0-or-later
// Pure modules of the app (no Gtk): colour table, stylesheet, text diff, layout.json read-modify-write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    APP_ID, COLORS, ISSUE_URL, PALETTE, TEXT_DARK, TEXT_LIGHT, WEBSITE, WINDOW_TITLE_PREFIX, buildCss, cssClassOf,
} from '../app/data.js';
import {changedRegion} from '../app/textdiff.js';
import {setOpen, shouldOpen, sizeOf} from '../app/layoutfile.js';
import {makeEnv, uuid} from '../tests/support/helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = c => {
    const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const [r, g, b] = c.map(f);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

test('PLAN 8: six colours, the plan\'s fills, text/fill contrast above 4.5 in both themes and on the header strip', () => {
    assert.deepEqual([...COLORS], ['yellow', 'green', 'blue', 'pink', 'purple', 'gray']);
    assert.equal(PALETTE.yellow.light, '#f6e58d');
    assert.equal(PALETTE.gray.dark, '#3a3a3a');
    for (const name of COLORS) {
        const p = PALETTE[name];
        assert.ok(contrast(p.light, TEXT_LIGHT) > 4.5, `${name} light`);
        assert.ok(contrast(p.lightHeader, TEXT_LIGHT) > 4.5, `${name} light header`);
        assert.ok(contrast(p.dark, TEXT_DARK) > 4.5, `${name} dark`);
        assert.ok(contrast(p.darkHeader, TEXT_DARK) > 4.5, `${name} dark header`);
    }
});

test('PLAN 8/7: the stylesheet is built from the table only; a colour class never comes from file content', () => {
    const css = buildCss();
    for (const name of COLORS) {
        assert.ok(css.includes(`window.cetli-${name} {`), name);
        assert.ok(css.includes(PALETTE[name].light) && css.includes(PALETTE[name].dark), name);
    }
    assert.equal(cssClassOf('yellow'), 'cetli-yellow');
    for (const bad of ['red', '', 'yellow; } window { display: none', undefined, null, '__proto__'])
        assert.equal(cssClassOf(bad), 'cetli-yellow', `unknown colour ${String(bad)} falls back to the default`);
    assert.equal(/[^\n]\{[^}]*\$\{/.test(css), false);
});

test('contract with the extension and the About constants', () => {
    assert.equal(APP_ID, 'io.github.trensoft.cetli');
    assert.equal(WINDOW_TITLE_PREFIX, 'cetli-');
    assert.equal(WEBSITE, 'https://github.com/trensoft/cetli');
    assert.equal(ISSUE_URL, 'https://github.com/trensoft/cetli/issues');
});

test('PLAN 3: the changed region is taken on code points, so the buffer keeps cursors outside it', () => {
    assert.equal(changedRegion('same', 'same'), null);
    assert.deepEqual(changedRegion('abc', 'abXc'), {start: 2, deleteCount: 0, insert: 'X'});
    assert.deepEqual(changedRegion('abc', 'ac'), {start: 1, deleteCount: 1, insert: ''});
    assert.deepEqual(changedRegion('', 'new'), {start: 0, deleteCount: 0, insert: 'new'});
    assert.deepEqual(changedRegion('old', ''), {start: 0, deleteCount: 3, insert: ''});
    // an emoji is ONE code point (two UTF-16 units): the offsets must count it once
    assert.deepEqual(changedRegion('a\u{1F389}b', 'a\u{1F389}XYb'), {start: 2, deleteCount: 0, insert: 'XY'});
    assert.deepEqual(changedRegion('\u{1F389}\u{1F389}', '\u{1F389}'), {start: 1, deleteCount: 1, insert: ''});
    // overlapping prefix and suffix ("aa" -> "aaa") must not count a character twice
    const r = changedRegion('aa', 'aaa');
    assert.equal(r.deleteCount, 0);
    assert.equal(r.insert, 'a');
    // reconstruct: applying the region to the old text gives the new text
    for (const [a, b] of [['hello world', 'hello brave new world'], ['x\u{1F600}y', 'x\u{1F601}y'], ['abcabc', 'abc'], ['\u00e9a', 'a\u00e9']]) {
        const reg = changedRegion(a, b);
        const arr = Array.from(a);
        arr.splice(reg.start, reg.deleteCount, ...Array.from(reg.insert));
        assert.equal(arr.join(''), b);
    }
});

test('layout.json: setOpen changes ONLY the open member of ONE entry and re-reads the file first', async () => {
    const env = makeEnv();
    try {
        await env.start();
        const [a, b] = [uuid(1), uuid(2)];
        const entry = n => ({x: n, y: n + 1, w: 300, h: 200, monitor: '1920x1080+0+0', open: true});
        await env.store.saveLayout({[a]: entry(1), [b]: entry(5)});
        assert.equal(await setOpen(env.store, a, false), true);
        let lay = await env.store.loadLayout();
        assert.deepEqual(lay[a], {...entry(1), open: false});
        assert.deepEqual(lay[b], entry(5), 'the other entry is untouched');
        // the extension writes between two of our calls (new geometry, a new entry): setOpen must not lose it
        await env.store.saveLayout({[a]: {...entry(9), open: false}, [b]: entry(5), [uuid(3)]: entry(7)});
        assert.equal(await setOpen(env.store, b, false), true);
        lay = await env.store.loadLayout();
        assert.equal(lay[a].x, 9, 'the extension\'s newer geometry survives');
        assert.ok(lay[uuid(3)], 'the extension\'s new entry survives');
        assert.equal(lay[b].open, false);
        assert.equal(await setOpen(env.store, b, false), false, 'no change, no write');
        assert.equal(await setOpen(env.store, uuid(9), false), false, 'an id without an entry is left alone');
        assert.equal(shouldOpen(lay, a), false);
        assert.equal(shouldOpen(lay, uuid(9)), true);
        assert.equal(shouldOpen({[a]: {open: true}}, a), true);
    } finally {
        env.cleanup();
    }
});

test('window size from the layout entry is clamped; no entry gives the fallback', () => {
    const fb = {width: 300, height: 260};
    const id = uuid(1);
    assert.deepEqual(sizeOf({}, id, fb, 120, 4000), fb);
    assert.deepEqual(sizeOf({[id]: {w: 500, h: 400}}, id, fb, 120, 4000), {width: 500, height: 400});
    assert.deepEqual(sizeOf({[id]: {w: 5, h: 99999}}, id, fb, 120, 4000), {width: 120, height: 4000});
    assert.deepEqual(sizeOf({[id]: {w: 0, h: NaN}}, id, fb, 120, 4000), fb);
});

test('static: SPDX header everywhere, _() only in strings.js, no network, process, eval or secret in app/', () => {
    const files = fs.readdirSync(path.join(root, 'app')).filter(f => f.endsWith('.js'));
    assert.ok(files.length >= 6);
    const code = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const f of files) {
        const text = fs.readFileSync(path.join(root, 'app', f), 'utf8');
        assert.match(text.split('\n').slice(0, 2).join('\n'), /SPDX-License-Identifier: GPL-3\.0-or-later/, f);
        const c = code(text);
        if (f !== 'strings.js')
            assert.equal(/(^|[^A-Za-z0-9_.])(_|gettext|ngettext)\(/.test(c), false, `${f}: a translatable text outside strings.js`);
        for (const [re, what] of [
            [/\b(Subprocess|spawn|exec|child_process|launch)\b/, 'process'],
            [/\b(fetch|XMLHttpRequest|WebSocket|Soup|http:)\b/, 'network'],
            [/\beval\s*\(|new\s+Function\b/, 'dynamic code'],
            [/syncthing|api[_-]?key|password|secret|token|credential/i, 'transport or credential'],
        ])
            assert.equal(re.test(c), false, `${f}: ${what}`);
    }
});

test('static: the user-visible strings are literal msgids that xgettext can see (no concatenation, no template literal)', () => {
    const c = fs.readFileSync(path.join(root, 'app/strings.js'), 'utf8').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const calls = [...c.matchAll(/\b_\(('[^'\\]*'|[^'][^)]*)\)/g)].map(m => m[1].trim());
    assert.ok(calls.length >= 20);
    for (const arg of calls)
        assert.match(arg, /^'[^'\\]*'$/, `_(${arg}) is not a plain single-quoted literal`);
});
