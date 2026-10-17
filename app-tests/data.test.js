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

test('PLAN 8: eight menu colours (gray known, not offered), the fills, text/fill contrast above 4.5 in both themes and on the header strip', () => {
    assert.deepEqual([...COLORS], ['yellow', 'pink', 'green', 'purple', 'orange', 'blue', 'mint', 'peach']);
    assert.equal(PALETTE.yellow.light, '#fbf1b8');
    assert.equal(PALETTE.gray.dark, '#3a3a3a');
    for (const name of [...COLORS, 'gray']) {
        const p = PALETTE[name];
        assert.ok(contrast(p.light, TEXT_LIGHT) > 4.5, `${name} light`);
        assert.ok(contrast(p.lightHeader, TEXT_LIGHT) > 4.5, `${name} light header`);
        assert.ok(contrast(p.dark, TEXT_DARK) > 4.5, `${name} dark`);
        assert.ok(contrast(p.darkHeader, TEXT_DARK) > 4.5, `${name} dark header`);
    }
});

// The rules of the stylesheet as {selector: {property: value}} (buildCss writes one rule per line).
function cssRules() {
    const out = new Map();
    for (const line of buildCss().split('\n').filter(Boolean)) {
        const m = /^(.*?) \{ (.*) \}$/.exec(line);
        assert.ok(m, `a rule per line: ${line}`);
        out.set(m[1], Object.fromEntries(m[2].split(';').map(d => d.trim()).filter(Boolean).map(d => d.split(/:\s*/))));
    }
    return out;
}
const mix = (fg, bg, alpha) => `#${[0, 1, 2].map(i => Math.round(alpha * rgb(fg)[i] + (1 - alpha) * rgb(bg)[i]).toString(16).padStart(2, '0')).join('')}`;

test('PLAN 8: the stylesheet ITSELF sets text and fill with 4.5:1 for every colour and both themes, also under the opacity of the small labels', () => {
    const rules = cssRules();
    const get = sel => {
        const r = rules.get(sel);
        assert.ok(r, `rule ${sel}`);
        return r;
    };
    const mark = get('window.cetli-note label.cetli-mark');
    const unresolved = get('window.cetli-note label.cetli-unresolved');
    for (const name of COLORS) {
        const p = PALETTE[name];
        for (const [fillSel, headSel, fill, head, text] of [
            [`window.cetli-${name}`, `window.cetli-${name} headerbar.cetli-header`, p.light, p.lightHeader, TEXT_LIGHT],
            [`window.cetli-dark.cetli-${name}`, `window.cetli-dark.cetli-${name} headerbar.cetli-header`, p.dark, p.darkHeader, TEXT_DARK],
        ]) {
            const f = get(fillSel);
            const h = get(headSel);
            assert.equal(f['background-color'], fill, fillSel);
            assert.equal(f.color, text, `${fillSel}: text colour`);
            assert.equal(h['background-color'], head, headSel);
            assert.equal(h.color, text, `${headSel}: text colour`);
            assert.ok(contrast(f.color, f['background-color']) >= 4.5, fillSel);
            assert.ok(contrast(h.color, h['background-color']) >= 4.5, headSel);
            // the small labels are drawn with their opacity over the fill (the mark) or over the header strip (unresolved)
            const m = Number(mark.opacity ?? 1);
            const u = Number(unresolved.opacity ?? 1);
            assert.ok(contrast(mix(f.color, f['background-color'], m), f['background-color']) >= 4.5, `${fillSel}: mark label at opacity ${m}`);
            assert.ok(contrast(mix(h.color, h['background-color'], u), h['background-color']) >= 4.5, `${headSel}: unresolved label at opacity ${u}`);
        }
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

test('layout.json: setOpen calls of one store are queued: two that overlap both end up in the file, and a failed one does not block the next', async () => {
    const [a, b, c] = [uuid(1), uuid(2), uuid(3)];
    const entry = n => ({x: n, y: n, w: 300, h: 200, monitor: 'm', open: true});
    let layout = {[a]: entry(1), [b]: entry(2), [c]: entry(3)};
    let failLoads = 0;
    const tick = () => new Promise(r => setTimeout(r, 5));
    const store = {
        async loadLayout() {
            await tick();
            if (failLoads > 0) {
                failLoads--;
                throw new Error('unreadable');
            }
            return structuredClone(layout);
        },
        async saveLayout(l) {
            await tick();
            layout = structuredClone(l);
            return {ok: true};
        },
    };
    // all three overlap: without the queue each reads the same file and the last write wins
    await Promise.all([setOpen(store, a, false), setOpen(store, b, false), setOpen(store, c, false)]);
    assert.deepEqual([a, b, c].map(id => layout[id].open), [false, false, false], 'no change was lost');
    // a failure rejects its own call only
    failLoads = 1;
    layout[a].open = true;
    const failing = setOpen(store, a, false);
    const next = setOpen(store, b, true);
    await assert.rejects(failing, /unreadable/);
    assert.equal(await next, true, 'the next call still runs');
    assert.equal(layout[b].open, true);
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
