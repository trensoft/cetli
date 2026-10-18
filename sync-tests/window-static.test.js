// SPDX-License-Identifier: GPL-3.0-or-later
// Static checks of the sync window (PLAN-0.2.6 5.3, 9 T-N26): the number of computers lives in sync/policy.js and reaches the window as
// `status.max_computers`; the window reads the group from `status.peers` and not from the one-peer fields of 0.2.5; the sentence about the
// accepted computer is the same words in both languages; every text of the window has a Hungarian translation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';

const root = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');
const code = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const appFiles = readdirSync(new URL('app/', root)).filter(f => f.endsWith('.js'));
// app/sync-bridge.js is left out of the literal check: it compares a byte with 10 (the line feed), which is not a number of computers.
const windowFiles = ['app/sync-wizard.js', 'app/sync-flow.js', 'app/sync-runner.js', 'app/sync-hook.js', 'app/sync-start.js', 'app/strings.js'];

test('the window files named here exist, so the checks below look at something', () => {
    for (const f of windowFiles)
        assert.ok(appFiles.includes(f.slice(4)), f);
});

test('the number of computers is not written in the window: no literal 9 or 10 outside comments (it comes from status.max_computers)', () => {
    for (const f of windowFiles)
        assert.equal(/(^|[^\w.'"-])(9|10)([^\w.'"-]|$)/m.test(code(read(f))), false, `${f} holds a literal 9 or 10`);
    // the texts take the number as a value: no "10 computers" or "9 computers" in any msgid
    for (const f of appFiles)
        assert.equal(/\b(9|10) computers\b/.test(read(`app/${f}`)), false, f);
});

test('the window reads the group from status.peers, not from the one-peer fields of 0.2.5', () => {
    for (const f of ['app/sync-wizard.js', 'app/sync-flow.js']) {
        const c = code(read(f));
        assert.equal(/\b(status|view|result)\.(peer|connected|link|shared|connected_s)\b/.test(c.replace(/\bout\.result\.(peer|connected_s)\b/g, '')), false, f);
        assert.equal(/\.shared\b/.test(c), false, `${f} reads a shared flag`);
    }
    assert.equal(/\bstatus\??\.peers\b/.test(code(read('app/sync-flow.js'))) || /peersOf\(/.test(code(read('app/sync-flow.js'))), true);
});

test('names from the engine reach labels with markup off: no label of the window turns markup on, no markup string is built', () => {
    for (const f of ['app/sync-wizard.js']) {
        const c = code(read(f));
        assert.equal(/use_markup:\s*true|set_use_markup\(\s*true|set_markup|\bmarkup:/.test(c), false, f);
        assert.equal(/Adw\.ActionRow|Adw\.ExpanderRow|body_use_markup|heading_use_markup/.test(c), false, `${f} uses a widget that reads markup by default`);
    }
});

// ---- the translation ----------------------------------------------------------------------------------------------------------------

// A catalog as {msgid: msgstr} (header and obsolete entries left out).
function parsePo(text) {
    const map = new Map();
    let key = null;
    let id = '';
    let str = '';
    const flush = () => {
        if (id !== '' || str !== '')
            map.set(id, str);
        id = str = '';
        key = null;
    };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('#~') || line === '' || line.startsWith('#')) {
            if (line === '' || line.startsWith('#~'))
                flush();
            continue;
        }
        const m = /^(msgid|msgstr)\s+(".*")$/.exec(line);
        if (m) {
            if (m[1] === 'msgid') {
                flush();
                key = 'id';
                id = JSON.parse(m[2]);
            } else {
                key = 'str';
                str = JSON.parse(m[2]);
            }
        } else if (/^".*"$/.test(line) && key !== null) {
            if (key === 'id')
                id += JSON.parse(line);
            else
                str += JSON.parse(line);
        }
    }
    flush();
    return map;
}

// The msgids of strings.js: every `_('...')` or `_("...")` call.
const msgids = () => [...read('app/strings.js').matchAll(/\b_\(('[^'\\]*'|"[^"\\]*")\)/g)].map(m => m[1].slice(1, -1));

const TRUST_EN = 'A computer you accept can add other computers to your group without asking you again. Remove a lost computer on all your computers.';
const TRUST_HU = 'Egy elfogadott számítógép újabb számítógépeket vehet fel a csoportodba anélkül, hogy újra megkérdezne. Az elveszett számítógépet az összes számítógépeden távolítsd el.';

test('the sentence about the accepted computer (Nicole): verbatim in English in strings.js and in Hungarian in the catalog', () => {
    assert.ok(msgids().includes(TRUST_EN));
    assert.equal(parsePo(read('po/hu.po')).get(TRUST_EN), TRUST_HU);
    const wizard = code(read('app/sync-wizard.js'));
    assert.ok((wizard.match(/S\.syncTrustSentence\(\)/g) ?? []).length >= 2, 'on the accept card (both pages) and in the footnote of the group page');
});

test('every text of the window has a Hungarian translation, and a translation keeps the %s placeholders of its msgid', () => {
    const hu = parsePo(read('po/hu.po'));
    const ids = msgids();
    assert.ok(ids.length > 100);
    for (const id of ids) {
        assert.ok(hu.has(id), `no entry in hu.po: ${id}`);
        const tr = hu.get(id);
        assert.notEqual(tr, '', `untranslated: ${id}`);
        assert.equal((tr.match(/%s/g) ?? []).length, (id.match(/%s/g) ?? []).length, `placeholders: ${id}`);
    }
});
