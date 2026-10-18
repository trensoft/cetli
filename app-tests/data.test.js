// SPDX-License-Identifier: GPL-3.0-or-later
// Pure modules of the app (no Gtk): colour table, stylesheet, text diff, layout.json read-modify-write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    APP_ID, COLORS, ISSUE_URL, KNOWN_COLORS, PALETTE, TEXT_DARK, TEXT_LIGHT, WEBSITE, WINDOW_TITLE_PREFIX, buildCss, cssClassOf,
    customRowStyle,
} from '../app/data.js';
import {PREVIEW_LINES, PREVIEW_LINE_CHARS, previewOf} from '../app/preview.js';
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

test('PLAN 8: six named menu colours (orange, mint, peach known, not offered), the fills, text/fill contrast above 4.5 in both themes and on the header strip', () => {
    assert.deepEqual([...COLORS], ['yellow', 'pink', 'green', 'purple', 'blue', 'gray']);
    assert.equal(PALETTE.yellow.light, '#fff6cb');
    assert.equal(PALETTE.gray.dark, '#3a3a3a');
    for (const name of KNOWN_COLORS) {
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
    for (const name of KNOWN_COLORS) {
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
    for (const name of KNOWN_COLORS) {
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

// The two exceptions of PLAN-WIZARD 0F.2 / 0H (B), nothing wider: app/sync-bridge.js starts the engine, so it is exempt from the
// PROCESS pattern only; app/strings.js names the program in the consent and install texts, so it is exempt from the WORD `syncthing`
// only. password, token, secret, credential and api key stay forbidden in every file, and the network and eval patterns in all.
const EXEMPT_PROCESS = ['sync-bridge.js'];
const EXEMPT_PROGRAM_WORD = ['strings.js'];

test('static: SPDX header everywhere, _() only in strings.js, no network, process, eval or secret in app/ (two narrow exceptions)', () => {
    const files = fs.readdirSync(path.join(root, 'app')).filter(f => f.endsWith('.js'));
    assert.ok(files.length >= 6);
    const code = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const f of files) {
        const text = fs.readFileSync(path.join(root, 'app', f), 'utf8');
        assert.match(text.split('\n').slice(0, 2).join('\n'), /SPDX-License-Identifier: GPL-3\.0-or-later/, f);
        const c = code(text);
        if (f !== 'strings.js')
            assert.equal(/(^|[^A-Za-z0-9_.])(_|gettext|ngettext)\(/.test(c), false, `${f}: a translatable text outside strings.js`);
        const credential = EXEMPT_PROGRAM_WORD.includes(f) ? /api[_-]?key|password|secret|token|credential/i : /syncthing|api[_-]?key|password|secret|token|credential/i;
        for (const [re, what, exempt] of [
            [/\b(Subprocess|spawn|exec|child_process|launch)\b/, 'process', EXEMPT_PROCESS.includes(f)],
            [/\b(fetch|XMLHttpRequest|WebSocket|Soup|http:)\b/, 'network', false],
            [/\beval\s*\(|new\s+Function\b/, 'dynamic code', false],
            [credential, 'transport or credential', false],
        ])
            assert.equal(exempt ? false : re.test(c), false, `${f}: ${what}`);
    }
});

test('static: the bridge uses the process API only with an argv array and the literal engine path (the exception is a whitelist, not a switch)', () => {
    const text = fs.readFileSync(path.join(root, 'app/sync-bridge.js'), 'utf8');
    const c = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    assert.match(c, /const ENGINE = '\/usr\/bin\/cetli-sync';/);
    assert.equal((c.match(/\/usr\/bin\//g) ?? []).length, 1, 'one literal path, the engine');
    assert.match(c, /launcher\.spawnv\(argv\)/);
    assert.equal(/Subprocess\.new|\.spawn\(|\bsh\b|\bbash\b|'-c'|"-c"|\/bin\/sh/.test(c), false, 'no shell, no string command');
    assert.equal(/getenv|setenv|apikey/i.test(c), false, 'no environment lookup, no key');
    assert.equal(/\bST[A-Z]{3,}/.test(c.replace(/Gio\.SubprocessFlags\.STD\w+/g, '')), false, 'no ST* variable name');
    assert.equal(/process\.env|GLib\.get_environ\(\)\.|environ\s*=/.test(c), false);
    const code = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const other = fs.readdirSync(path.join(root, 'app')).filter(f => f.endsWith('.js') && f !== 'sync-bridge.js');
    for (const f of other)
        assert.equal(/\bSubprocess\b/.test(code(fs.readFileSync(path.join(root, 'app', f), 'utf8'))), false, `${f} starts a process`);
});

test('static: the word for the sync program is in strings.js alone; no other app file says it', () => {
    const files = fs.readdirSync(path.join(root, 'app')).filter(f => f.endsWith('.js'));
    const code = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const f of files)
        assert.equal(/syncthing/i.test(code(fs.readFileSync(path.join(root, 'app', f), 'utf8'))), EXEMPT_PROGRAM_WORD.includes(f), f);
});

test('static: the user-visible strings are literal msgids that xgettext can see (no concatenation, no template literal)', () => {
    const c = fs.readFileSync(path.join(root, 'app/strings.js'), 'utf8').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const calls = [...c.matchAll(/\b_\(('[^'\\]*'|[^'][^)]*)\)/g)].map(m => m[1].trim());
    assert.ok(calls.length >= 20);
    for (const arg of calls)
        assert.match(arg, /^'[^'\\]*'$/, `_(${arg}) is not a plain single-quoted literal`);
});

// ---- 0.2.1 "All notes" ----------------------------------------------------------------------------------------------

test('"All notes": the preview of a note is its first lines, cut by code points; empty, long and odd texts', () => {
    assert.deepEqual(previewOf(''), {text: '', empty: true});
    assert.deepEqual(previewOf(' \n\t\r\n  '), {text: '', empty: true}, 'blanks only is empty');
    assert.deepEqual(previewOf(undefined), {text: '', empty: true});
    assert.deepEqual(previewOf('  hello  '), {text: 'hello', empty: false});
    assert.equal(previewOf('\n\n\nfirst\n\n  second  \nthird\nfourth').text, 'first\nsecond\nthird', `at most ${PREVIEW_LINES} lines, blank lines skipped`);
    assert.equal(previewOf('a\r\nb\rc').text, 'a\nb\nc', 'every line end');
    const cutLine = previewOf('x'.repeat(5000)).text;
    assert.equal(Array.from(cutLine).length, PREVIEW_LINE_CHARS + 1);
    assert.ok(cutLine.endsWith('…'));
    assert.equal(previewOf('x'.repeat(PREVIEW_LINE_CHARS)).text, 'x'.repeat(PREVIEW_LINE_CHARS), 'a line of exactly the limit is not cut');
    // an emoji is ONE code point and a cut never leaves half of a pair (a lone surrogate is not valid text for a label)
    for (const n of [PREVIEW_LINE_CHARS - 1, PREVIEW_LINE_CHARS, PREVIEW_LINE_CHARS + 1, 700, 3000])
        assert.equal(previewOf('\u{1F389}'.repeat(n)).text.isWellFormed(), true, `${n} emoji`);
    // the head ends INSIDE a pair (the high half is the 800th unit): the half is dropped, the lines before it are untouched
    const split = `${'x'.repeat(400)}\n${'y'.repeat(397)}\n\u{1F389}z`;
    assert.equal(split.charCodeAt(799) >= 0xd800 && split.charCodeAt(799) <= 0xdbff, true, 'the test text really splits a pair at the cut');
    assert.equal(previewOf(split).text.isWellFormed(), true, 'no lone surrogate from a cut inside a pair');
    assert.equal(previewOf('\u{1F389}'.repeat(PREVIEW_LINE_CHARS + 5)).text, `${'\u{1F389}'.repeat(PREVIEW_LINE_CHARS)}…`);
    // blank lines before the text do not hide it (the head that is read starts at the first non-blank character)
    assert.equal(previewOf(`${'\n'.repeat(5000)}late`).text, 'late');
    // a note of the maximum size: only a head is read (fast), the preview stays small
    const t0 = process.hrtime.bigint();
    const big3 = previewOf('line of text\n'.repeat(5000));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(big3.text, 'line of text\nline of text\nline of text');
    assert.ok(ms < 50, `64 KB preview in ${ms.toFixed(2)} ms`);
    // a 64 KB single line
    assert.equal(Array.from(previewOf('z'.repeat(65536)).text).length, PREVIEW_LINE_CHARS + 1);
});

test('"All notes": the list rows use the fills and texts of the note windows; every row of every known colour is >= 7:1 (light) and >= 4.5:1 (dark)', () => {
    const css = buildCss();
    const rules = new Map(css.split('\n').filter(Boolean).map(l => /^(.*?) \{ (.*) \}$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
    for (const name of KNOWN_COLORS) {
        const p = PALETTE[name];
        assert.equal(rules.get(`window.cetli-list row.cetli-row.cetli-${name}`), `background-color: ${p.light}; color: ${TEXT_LIGHT};`, name);
        assert.equal(rules.get(`window.cetli-list.cetli-dark row.cetli-row.cetli-${name}`), `background-color: ${p.dark}; color: ${TEXT_DARK};`, name);
        assert.ok(contrast(p.light, TEXT_LIGHT) >= 7 && contrast(p.dark, TEXT_DARK) >= 4.5, name);
    }
    for (const sel of ['window.cetli-list listbox.cetli-rows', 'window.cetli-list row.cetli-row', 'window.cetli-list row.cetli-row:hover', 'window.cetli-list row.cetli-row label.cetli-empty'])
        assert.ok(rules.has(sel), sel);
    assert.equal(/cetli-x-/.test(css), false, 'the shared stylesheet holds no custom colour');
});

test('"All notes": the row style of a custom colour comes from three numbers; anything else has none', () => {
    const st = customRowStyle('#1a2b3c');
    assert.equal(st.cls, 'cetli-x-1a2b3c');
    assert.match(st.css, /^window\.cetli-list row\.cetli-row\.cetli-x-1a2b3c, window\.cetli-list\.cetli-dark row\.cetli-row\.cetli-x-1a2b3c \{ background-color: #1a2b3c; color: #(000000|ffffff); \}\n$/);
    assert.equal(customRowStyle('#ffffff').css.includes('color: #000000'), true);
    assert.equal(customRowStyle('#000000').css.includes('color: #ffffff'), true);
    for (const bad of ['#AABBCC', '#aabbcc;}', '#aabbcc\n', 'red', '', null, undefined, 7, 'a'.repeat(100000), '#aabbcc} window { display: none'])
        assert.equal(customRowStyle(bad), null, String(bad).slice(0, 30));
});

test('i18n: the "All notes" texts are in the template and in both catalogs, in Hungarian with accents; the three catalogs agree', () => {
    const read = f => fs.readFileSync(path.join(root, f), 'utf8');
    // A long msgid is wrapped by gettext over several quoted lines: join them.
    const ids = text => new Set([...text.matchAll(/^msgid ((?:".*"\n)+)/gm)].map(m => m[1].trim().split('\n').map(l => l.slice(1, -1)).join('')));
    const strings = read('app/strings.js');
    const fromCode = new Set([...strings.matchAll(/\b_\('([^'\\]*)'\)/g)].map(m => m[1]));
    const pot = ids(read('po/cetli.pot')), en = ids(read('po/en.po')), hu = ids(read('po/hu.po'));
    for (const id of ['All notes', '(empty note)']) {
        assert.ok(fromCode.has(id), `${id} in strings.js`);
        for (const [name, set] of [['cetli.pot', pot], ['en.po', en], ['hu.po', hu]])
            assert.ok(set.has(id), `${id} in ${name}`);
    }
    for (const id of fromCode) {
        assert.ok(pot.has(id) && en.has(id) && hu.has(id), `msgid "${id}" is in all three catalogs`);
    }
    assert.match(read('po/hu.po'), /msgid "All notes"\nmsgstr "Összes jegyzet"/);
    assert.match(read('po/hu.po'), /msgid "\(empty note\)"\nmsgstr "\(üres jegyzet\)"/);
    assert.match(read('po/cetli.pot'), /msgid "All notes"\nmsgstr ""/);
    assert.match(read('po/en.po'), /msgid "All notes"\nmsgstr ""/);
    // the "Translators" comment travels with the template for the one text that needs context
    assert.match(read('po/cetli.pot'), /#\. Translators: shown in the "All notes" list for a note that has no text\.\n#: app\/strings\.js\nmsgid "\(empty note\)"/);
});

test('"All notes": the list window has a title of its own; only note windows are cetli-<uuid>', () => {
    const strings = read('app/strings.js');
    assert.match(strings, /export const allNotesTitle = \(\) => _\('All notes'\);/);
    assert.equal(/WINDOW_TITLE_PREFIX/.test(read('app/allnotes.js')), false, 'the list code never builds a cetli-<uuid> title');
    function read(f) { return fs.readFileSync(path.join(root, f), 'utf8'); }
});
