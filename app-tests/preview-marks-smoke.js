// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the formatted card preview of the "All notes" window (0.2.2): run it inside a headless Wayland compositor,
// see app-tests/run.sh. Notes arrive the way another computer sends them (a file with `marks`); the card is read back from the
// label: its text, whether it is markup, and the Pango attributes GTK laid on it. The pure part is preview-marks.test.js.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import {createApp} from '../app/application.js';
import {cardMarkup} from '../app/allnotes.js';
import {PREVIEW_LINE_CHARS, matchesQuery} from '../app/preview.js';
import * as S from '../app/strings.js';

const base = GLib.dir_make_tmp('cetli-pm-XXXXXX');
const dirs = {notes: `${base}/data/notes`, tmp: `${base}/data/tmp`, state: `${base}/state`};
let failed = 0;
let checks = 0;
const check = (cond, label) => {
    checks++;
    if (cond) {
        print(`ok   ${label}`);
    } else {
        failed++;
        print(`FAIL ${label}`);
    }
};
const readText = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const fileRec = id => JSON.parse(readText(`${dirs.notes}/${id}.json`));
const tick = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
async function waitFor(cond, limit = 8000) {
    const t0 = GLib.get_monotonic_time();
    for (;;) {
        if (cond())
            return true;
        if ((GLib.get_monotonic_time() - t0) / 1000 > limit)
            return false;
        await tick(40);
    }
}
function remotePut(id, rec) {
    const tmp = `${dirs.notes}/.syncthing.${id}.json.tmp`;
    GLib.file_set_contents(tmp, `${JSON.stringify(rec)}\n`);
    Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(`${dirs.notes}/${id}.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
}
let seq = 0;
const stamp = () => new Date(Date.now() + 60000 + (seq++) * 1000).toISOString();
const remoteRecord = (over = {}) => {
    const id = over.id ?? GLib.uuid_string_random();
    const t = stamp();
    return {schema: 1, id, rev: 1, updated: t, created: t, device: 'b5b5b5b5', color: 'pink', text: 'remote', deleted: false, conflict_of: null, ...over};
};
// The stored hash: the first 16 hex of the sha256 of the UTF-8 text. Checked against the published sha256 of "abc" below.
const h16 = text => GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, new TextEncoder().encode(text)).slice(0, 16);
const marksOf = (text, r) => ({h: h16(text), r});

// A warning from GTK or GLib is a failure of the card (e.g. a label that reads a plain text as markup).
const warnings = [];
for (const domain of ['Gtk', 'Pango', 'GLib', 'Gdk', 'Gjs', null])
    GLib.log_set_handler(domain, GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL, (_d, _l, msg) => { warnings.push(msg); });

const ctl = createApp({dirs});
const {gtkApp, windows} = ctl;

const KINDS = {1: Pango.attr_weight_new(Pango.Weight.BOLD), 2: Pango.attr_style_new(Pango.Style.ITALIC), 4: Pango.attr_underline_new(Pango.Underline.SINGLE), 8: Pango.attr_strikethrough_new(true)};
// What GTK laid on the label, as one flags number per code point of the shown text (Pango counts UTF-8 bytes).
function flagsShown(label) {
    const text = label.get_text();
    const enc = new TextEncoder().encode(text);
    const cpOfByte = new Map();
    let b = 0;
    Array.from(text).forEach((ch, i) => {
        cpOfByte.set(b, i);
        b += new TextEncoder().encode(ch).length;
    });
    cpOfByte.set(enc.length, Array.from(text).length);
    const out = new Array(Array.from(text).length).fill(0);
    for (const a of label.get_layout().get_attributes()?.get_attributes() ?? []) {
        for (const [bit, k] of Object.entries(KINDS)) {
            if (!k.equal(a))
                continue;
            for (let i = cpOfByte.get(a.start_index); i < cpOfByte.get(Math.min(a.end_index, enc.length)); i++)
                out[i] |= Number(bit);
        }
    }
    return out;
}
const flagsOf = (n, ranges) => {
    const out = new Array(n).fill(0);
    for (const [s, e, f] of ranges) {
        for (let i = s; i < Math.min(e, n); i++)
            out[i] |= f;
    }
    return out;
};

async function scenario() {
    await ctl.ready;
    gtkApp.activate_action('all-notes', null);
    check(await waitFor(() => ctl.allNotes !== null), '"All notes" opens');
    const list = ctl.allNotes;
    const row = id => list.rows.get(id);
    const lab = id => row(id)?.label;

    // the notes arrive closed (a window per note is not what is measured here)
    const layout = await ctl.store.loadLayout();
    const put = async (over, ranges, extra = {}) => {
        const rec = remoteRecord({...over, ...(ranges === null ? {} : {marks: marksOf(over.text, ranges)}), ...extra});
        layout[rec.id] = {x: 0, y: 0, w: 300, h: 260, monitor: 'test', open: false};
        await ctl.store.saveLayout(layout);
        remotePut(rec.id, rec);
        check(await waitFor(() => list.rows.has(rec.id) && row(rec.id).v !== null, 10000), `row of ${JSON.stringify(String(over.text).slice(0, 24))} appears`);
        return rec;
    };
    const shows = (id, text, ranges) => lab(id).get_use_markup() && lab(id).get_text() === text && JSON.stringify(flagsShown(lab(id))) === JSON.stringify(flagsOf(Array.from(text).length, ranges));

    check(h16('abc') === 'ba7816bf8f01cfea', 'the test\'s hash is the published sha256 of "abc"');

    // ---- the old card: no marks key -> the label is the plain text, not markup, byte for byte
    const plain = await put({text: 'plain <b>note</b> & more\nsecond line'}, null);
    check(!lab(plain.id).get_use_markup() && lab(plain.id).get_label() === 'plain <b>note</b> & more\nsecond line', 'a note with no marks: plain label, text as is (markup characters shown as typed)');
    check(flagsShown(lab(plain.id)).every(f => f === 0), 'and no style is laid on it');

    // ---- the formatted card
    const bold = await put({text: 'hello world'}, [[0, 5, 1]]);
    check(lab(bold.id).get_use_markup() && lab(bold.id).get_label() === '<b>hello</b> world', `bold word: markup ${lab(bold.id).get_label()}`);
    check(shows(bold.id, 'hello world', [[0, 5, 1]]), 'GTK draws exactly "hello" in bold, the rest as it was');
    const all4 = await put({text: 'one two three four'}, [[0, 3, 1], [4, 7, 2], [8, 13, 4], [14, 18, 8]]);
    check(shows(all4.id, 'one two three four', [[0, 3, 1], [4, 7, 2], [8, 13, 4], [14, 18, 8]]), 'bold, italic, underline and strikethrough are each drawn on their own word');
    const mixed = await put({text: 'both here'}, [[0, 4, 15]]);
    check(shows(mixed.id, 'both here', [[0, 4, 15]]), 'a word with all four flags has all four styles');
    const lines = await put({text: '\n  title\nsecond line\n  third  \nfourth'}, [[3, 8, 1], [9, 15, 2], [24, 28, 4], [31, 37, 8]]);
    check(lab(lines.id).get_text() === 'title\nsecond line\nthird', 'a card with blank lines and indentation shows 3 trimmed lines');
    check(JSON.stringify(flagsShown(lab(lines.id))) === JSON.stringify(flagsOf(23, [[0, 5, 1], [6, 12, 2], [19, 23, 4]])),
        'the formatting follows its words over the removed blanks (title bold, "second" italic, "hird" underlined; the 4th line is not shown)');
    const emoji = await put({text: '\u{1F600}\u{1F600}ab \u{1F600}cd'}, [[2, 4, 1], [6, 8, 2]]);
    check(shows(emoji.id, '\u{1F600}\u{1F600}ab \u{1F600}cd', [[2, 4, 1], [6, 8, 2]]), 'offsets are code points: after two emoji "ab" is bold, "cd" italic');
    const long = await put({text: `${'x'.repeat(70)}${'y'.repeat(60)}\nshort`}, [[60, 130, 1]]);
    check(lab(long.id).get_text() === `${'x'.repeat(70)}${'y'.repeat(10)}…\nshort` && flagsShown(lab(long.id)).slice(0, 60).every(f => f === 0) &&
        flagsShown(lab(long.id)).slice(60, 80).every(f => f === 1) && flagsShown(lab(long.id))[80] === 0, 'a cut line: the bold stops with the cut, the … is plain');
    check(Array.from(lab(long.id).get_text().split('\n')[0]).length === PREVIEW_LINE_CHARS + 1, 'and the line has the same length as a plain card');

    // ---- the text is data: markup written in a note is shown as typed, and cannot style or break the card
    const evil = '<span foreground="red" size="9999">big</span> & <b>x</b> &amp; &#0; ]]> <!-- -->';   // 80 code points: not cut
    check(Array.from(evil).length <= PREVIEW_LINE_CHARS, 'the hostile text fits one line');
    const evilNote = await put({text: evil}, [[0, Array.from(evil).length, 2]]);
    check(lab(evilNote.id).get_use_markup() && lab(evilNote.id).get_text() === evil, 'markup typed in a note is shown as typed');
    check(JSON.stringify(flagsShown(lab(evilNote.id))) === JSON.stringify(new Array(Array.from(evil).length).fill(2)), 'and only the italic of the stored mark is laid on it (no colour, no size)');
    check(lab(evilNote.id).get_layout().get_attributes().get_attributes().every(a => KINDS[2].equal(a)), 'not one other attribute exists');
    check(row(evilNote.id).text === evil && fileRec(evilNote.id).text === evil, 'the text kept by the row and the file is the note text, not markup');

    // ---- anything wrong with the stored marks: the card is plain, the note is not touched
    const stale = await put({text: 'text that an old client rewrote'}, null, {marks: marksOf('the old text', [[0, 3, 1]])});
    check(!lab(stale.id).get_use_markup() && lab(stale.id).get_label() === 'text that an old client rewrote', 'marks of another text (hash mismatch, old client): plain card');
    const hostile = [
        ['overlapping ranges', [[0, 3, 1], [2, 4, 1]]],
        ['unsorted ranges', [[3, 4, 1], [0, 2, 1]]],
        ['a range behind the text', [[0, 400, 1]]],
        ['flags 0', [[0, 2, 0]]],
        ['flags 16', [[0, 2, 16]]],
        ['a fraction', [[0.5, 2, 1]]],
        ['a string offset', [['0', 2, 1]]],
        ['an empty list', []],
        ['more than 256 ranges', Array.from({length: 300}, (_, i) => [i, i + 1, 1])],
        ['not a list', 'bold'],
        ['null', null],
        ['an object', {0: [0, 2, 1]}],
    ];
    for (const [what, r] of hostile) {
        const text = `hostile marks: ${what}, text long enough`;
        const rec = await put({text}, null, {marks: {h: h16(text), r}});
        check(!lab(rec.id).get_use_markup() && lab(rec.id).get_label() === text && JSON.stringify(fileRec(rec.id).marks.r) === JSON.stringify(r), `${what}: plain card, file untouched`);
    }
    const notObject = await put({text: 'marks is a string'}, null, {marks: 'bold'});
    check(!lab(notObject.id).get_use_markup() && lab(notObject.id).get_label() === 'marks is a string', 'marks that is not an object: plain card');
    const noHash = await put({text: 'marks without a hash'}, null, {marks: {r: [[0, 3, 1]]}});
    check(!lab(noHash.id).get_use_markup() && lab(noHash.id).get_label() === 'marks without a hash', 'marks without h: plain card');
    const upperHash = await put({text: 'upper case hash here'}, null, {marks: {h: h16('upper case hash here').toUpperCase(), r: [[0, 5, 1]]}});
    check(!lab(upperHash.id).get_use_markup(), 'an upper-case h is not the stored form: plain card');
    const behindText = 'l1\nl2\nl3\nfourth line';
    const behind = await put({text: behindText}, [[9, 15, 1]]);
    check(!lab(behind.id).get_use_markup() && lab(behind.id).get_label() === 'l1\nl2\nl3', 'a formatting only on a line that is not shown: plain card');
    const emptyNote = await put({text: '  \n '}, [[0, 3, 1]]);
    check(!lab(emptyNote.id).get_use_markup() && lab(emptyNote.id).get_label() === S.emptyNotePreview(), 'a note of blanks with marks: the placeholder, not markup');
    // a NUL cannot be passed to a label (the C string ends there); the markup would be cut in the middle of a tag
    const nul = await put({text: 'ab\u0000cd'}, [[0, 5, 1]]);
    check(!lab(nul.id).get_use_markup() && lab(nul.id).get_label() === 'ab', 'a NUL inside a formatted range: the card stays plain, as without marks');

    // ---- the list is a reader: the files keep their marks, the search still reads the text
    check(JSON.stringify(fileRec(bold.id).marks) === JSON.stringify(marksOf('hello world', [[0, 5, 1]])), 'the file of a formatted note is as it was');
    check(row(bold.id).text === 'hello world' && !matchesQuery(row(bold.id).text, '<b>') && matchesQuery(row(plain.id).text, '<b>'),
        'the search reads the text of a formatted note, not its markup ("<b>" finds only the note that has it typed)');

    // ---- changes from the other computer
    // marks removed, same text: the card goes plain, and the text that follows is NOT read as markup (use_markup went back)
    const rb = fileRec(bold.id);
    const noMarks = {...rb};
    delete noMarks.marks;
    remotePut(bold.id, {...noMarks, rev: rb.rev + 1, updated: stamp(), text: 'a <b>c</b> & d'});
    check(await waitFor(() => lab(bold.id).get_label() === 'a <b>c</b> & d'), 'a remote change removes the marks and the text: the card is the new text');
    check(!lab(bold.id).get_use_markup() && lab(bold.id).get_text() === 'a <b>c</b> & d' && flagsShown(lab(bold.id)).every(f => f === 0), 'and it is plain: "<b>" is shown as typed, not read as markup');
    // marks added, same text
    const rp = fileRec(plain.id);
    remotePut(plain.id, {...rp, rev: rp.rev + 1, updated: stamp(), marks: marksOf(rp.text, [[0, 5, 1]])});
    check(await waitFor(() => lab(plain.id).get_use_markup() && lab(plain.id).get_text() === rp.text), 'marks added to an unchanged text reach the card');
    check(shows(plain.id, rp.text, [[0, 5, 1]]), 'and "plain" is bold');
    // marks changed, same text
    const rp2 = fileRec(plain.id);
    remotePut(plain.id, {...rp2, rev: rp2.rev + 1, updated: stamp(), marks: marksOf(rp2.text, [[6, 9, 2]])});
    check(await waitFor(() => !lab(plain.id).get_label().startsWith('<b>')), 'changed marks on an unchanged text reach the card');
    check(shows(plain.id, rp2.text, [[6, 9, 2]]), 'and the italic is where the new marks say');
    // text changed by an old client, marks stale -> plain
    const rp3 = fileRec(plain.id);
    remotePut(plain.id, {...rp3, rev: rp3.rev + 1, updated: stamp(), text: 'rewritten by an old client'});
    check(await waitFor(() => lab(plain.id).get_label() === 'rewritten by an old client' && !lab(plain.id).get_use_markup()), 'an old client rewrites the text and leaves the marks: the card turns plain');

    // ---- cardMarkup: the glue itself
    check(cardMarkup('hello world', new Map([['marks', marksOf('hello world', [[0, 5, 1]])]])) === '<b>hello</b> world', 'cardMarkup reads a Map (the record of the core)');
    check(cardMarkup('hello world', {marks: marksOf('hello world', [[0, 5, 1]])}) === '<b>hello</b> world', 'and a plain object');
    check(cardMarkup('hello world', new Map()) === null && cardMarkup('hello world', undefined) === null && cardMarkup('hello world', null) === null && cardMarkup(undefined, new Map()) === null, 'no marks, no extra, no text: null');
    check(cardMarkup('hello world', new Map([['marks', marksOf('hello world!', [[0, 5, 1]])]])) === null, 'a hash of another text: null');
    const realParse = Pango.parse_markup;
    Pango.parse_markup = () => { throw new Error('Pango refuses this markup'); };
    const refused = cardMarkup('hello world', new Map([['marks', marksOf('hello world', [[0, 5, 1]])]]));
    Pango.parse_markup = realParse;
    check(warnings.length === 0, `no warning from GTK, Pango or GLib during the whole run (${warnings.length}: ${warnings.slice(0, 2).join(' | ').slice(0, 200)})`);
    check(refused === null, 'markup that Pango refuses: null (the card is plain, never empty)');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
