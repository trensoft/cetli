// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the GTK app: run it inside a headless Wayland compositor, see app-tests/run.sh.
// It drives the real application.js with the real core and the real Gio layer, in a temporary XDG tree.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {createApp} from '../app/application.js';
import {NOTE_RHEL_RED, buildCss, cssClassOf} from '../app/data.js';
import * as S from '../app/strings.js';
import {CAUSE} from '../src/constants.js';
import {NOTE_COLOR_IDS} from '../src/colors.js';

const base = GLib.dir_make_tmp('cetli-gtk-XXXXXX');
const dirs = {
    notes: `${base}/data/notes`, tmp: `${base}/data/tmp`, state: `${base}/state`,
};
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
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
// Waits for a condition instead of a fixed time: under load the save timer, the fsync and the monitor can take seconds. A condition
// that never comes true is still a failure, after `limit` ms.
const until = async (cond, limit = 10000) => { for (let t = 0; t < limit && !cond(); t += 50) await sleep(50); };
const readText = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
const noteFiles = () => {
    const d = Gio.File.new_for_path(dirs.notes);
    const out = [];
    const en = d.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let i;
    while ((i = en.next_file(null)) !== null)
        out.push(i.get_name());
    return out.sort();
};
const fileRec = id => JSON.parse(readText(`${dirs.notes}/${id}.json`));
// What Syncthing does: a hidden tmp file, then a rename.
function remoteWrite(id, patch) {
    const rec = {...fileRec(id), ...patch};
    const tmp = `${dirs.notes}/.syncthing.${id}.json.tmp`;
    GLib.file_set_contents(tmp, `${JSON.stringify(rec)}\n`);
    Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(`${dirs.notes}/${id}.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
}

const ctl = createApp({dirs});
const {gtkApp, windows} = ctl;

// A second activation while the core is still starting (a double launch): start() must run once.
let startCalls = 0;
const realStart = ctl.store.start.bind(ctl.store);
ctl.store.start = (...args) => {
    startCalls++;
    return realStart(...args);
};
let doubled = false;
gtkApp.connect('activate', () => {
    if (!doubled) {
        doubled = true;
        gtkApp.activate();
    }
});

async function scenario() {
    await ctl.ready;
    check(doubled && startCalls === 1, `two activations before the core was up: the core started once (${startCalls})`);
    // the stylesheet parses without a single error in this GTK
    const provider = new Gtk.CssProvider();
    let cssErrors = 0;
    provider.connect('parsing-error', (_p, _section, err) => { cssErrors++; print(`css error: ${err.message}`); });
    if (typeof provider.load_from_string === 'function')
        provider.load_from_string(buildCss());
    else
        provider.load_from_data(buildCss());
    check(cssErrors === 0, 'the stylesheet has no parsing error');
    // first run: one new, empty note
    check(windows.size === 1, 'first run: one note window');
    const [id, w] = [...windows][0];
    check(w.win.get_title() === `cetli-${id}`, `window title is cetli-<uuid> (${w.win.get_title()})`);
    check(w.win.get_visible(), 'window is shown');
    check(noteFiles().length === 1, 'the new note is a file');
    // the first note is red (0.2.4): the exact #ee0000 in the file, the class of that colour on the window and no class of a name colour;
    // the "Important" title is shown for this colour only, and the text is bold by style (nothing in the file but the colour)
    check(fileRec(id).color === NOTE_RHEL_RED && w.win.has_css_class('cetli-x-ee0000') && !NOTE_COLOR_IDS.some(c => w.win.has_css_class(`cetli-${c}`)),
        `default colour: the red (${fileRec(id).color})`);
    check(w.titleLabel.get_label() === S.importantTitle() && w.titleLabel.get_mapped() && S.importantTitle() !== '',
        `the red note has the title "${w.titleLabel.get_label()}" in its header`);
    check(fileRec(id).extra === undefined || fileRec(id).extra.marks === undefined, 'the bold of the red is a style: no marks in the file');

    // editing and coalesced save
    w.buffer.insert_at_cursor('héllo 🎉', -1);
    w.buffer.insert_at_cursor(' world', -1);
    await sleep(700);
    check(fileRec(id).text === 'héllo 🎉 world', 'typed text saved (UTF-8, coalesced)');
    check(fileRec(id).rev === 2, `one write for the burst (rev ${fileRec(id).rev})`);

    // colour
    const startColor = w.color;
    const pickedColor = NOTE_COLOR_IDS.find(c => c !== startColor);
    w.setColor(pickedColor);
    await sleep(500);
    check(fileRec(id).color === pickedColor && w.win.has_css_class(`cetli-${pickedColor}`) && !w.win.has_css_class(cssClassOf(startColor)), 'colour change saved and class swapped');
    check(w.titleLabel.get_label() === '', 'a colour other than the exact red has no title');
    w.setColor('#ed0000');
    check(w.titleLabel.get_label() === '', 'a near red (#ed0000) has no title either');
    w.setColor(NOTE_RHEL_RED);
    check(w.titleLabel.get_label() === S.importantTitle(), 'back to the exact red: the title is there again');
    w.setColor(pickedColor);
    await sleep(500);

    // remote version, window clean and quiet: text replaced, cursor after the change shifts
    await sleep(2200);
    const end = w.buffer.get_iter_at_offset(w.buffer.get_char_count());
    w.buffer.place_cursor(end);
    remoteWrite(id, {rev: fileRec(id).rev + 1, updated: new Date(Date.now() + 1000).toISOString(), device: 'b5b5b5b5', text: 'REMOTE héllo 🎉 world'});
    await sleep(1000);
    check(w._bufferText() === 'REMOTE héllo 🎉 world', `clean window takes the remote text (${w._bufferText()})`);
    check(w.buffer.get_iter_at_mark(w.buffer.get_insert()).get_offset() === Array.from('REMOTE héllo 🎉 world').length, 'cursor at the end stays at the end');
    check(w.mark === null, 'no mark after applying');
    w.buffer.insert_at_cursor('+', -1);
    await sleep(600);
    check(noteFiles().length === 1, 'editing after applying a remote version makes no copy (the applied record is the base)');

    // remote version while typing: buffer untouched, mark shown, local wins, the other version kept as a copy
    w.buffer.insert_at_cursor('!', -1);
    remoteWrite(id, {rev: fileRec(id).rev + 1, updated: new Date(Date.now() + 3000).toISOString(), device: 'b5b5b5b5', text: 'second remote'});
    await sleep(450);
    check(w._bufferText().endsWith('!') && w._bufferText() !== 'second remote', 'typing window keeps its text');
    await until(() => fileRec(id).text.endsWith('!') && noteFiles().length === 2);
    check(fileRec(id).text.endsWith('!'), 'local text won');
    check(noteFiles().length === 2, `the other version was kept as a copy (${noteFiles().length} files)`);

    // a remote tombstone: window stays, mark shown
    const t = fileRec(id);
    remoteWrite(id, {rev: t.rev + 1, updated: new Date(Date.now() + 5000).toISOString(), device: 'b5b5b5b5', text: '', deleted: true});
    await sleep(2300);
    check(windows.has(id) && w.mark?.kind === 'deleted', 'remote tombstone: window stays with a mark');
    w.buffer.insert_at_cursor('x', -1);
    await sleep(700);
    check(fileRec(id).deleted === false, 'typing brings the note back');

    // a conflict file: kept and counted
    const cf = `${dirs.notes}/${id}.sync-conflict-20261017-120000-ABCDEFG.json`;
    GLib.file_set_contents(cf, `${JSON.stringify({...fileRec(id), rev: 99, text: 'conflict'})}\n`);
    await sleep(800);
    check(exists(cf), 'conflict file is kept');
    check(w.unresolved.get_visible() && w.unresolved.get_label() === '1 unresolved', `unresolved mark (${w.unresolved.get_label()})`);

    // new note through the application action
    const sizeBefore = windows.size;
    gtkApp.activate_action('new-note', null);
    await sleep(600);
    check(windows.size === sizeBefore + 1, `New note opens one more window (${sizeBefore} -> ${windows.size})`);

    // layout.json: an entry written by the extension; closing a window writes open=false, nothing else changes
    const [id2, w2] = [...windows].find(([k]) => k !== id);
    // only the first note is red: the second gets a name colour from the core's pick, not the red
    check(fileRec(id2).color !== NOTE_RHEL_RED && NOTE_COLOR_IDS.includes(fileRec(id2).color) && !w2.win.has_css_class('cetli-x-ee0000'),
        `the second new note is not red (${fileRec(id2).color})`);
    await ctl.store.saveLayout({[id2]: {x: 10, y: 20, w: 321, h: 222, monitor: '1920x1080+0+0', open: true}});
    w2.win.close();
    await sleep(500);
    const lay = JSON.parse(readText(`${dirs.state}/layout.json`));
    check(lay[id2].open === false && lay[id2].x === 10 && lay[id2].w === 321 && lay[id2].monitor === '1920x1080+0+0', 'closing writes open=false and keeps the extension members');
    check(!windows.has(id2), 'closed window removed from the app');

    // another launch of the program: the closed note comes back and its flag is true again
    gtkApp.activate();
    await sleep(600);
    check(windows.has(id2), 'a second launch brings the closed note back');
    check(JSON.parse(readText(`${dirs.state}/layout.json`))[id2].open === true, 'and writes open=true');

    // ---- guards of the remote text, refused saves, the cursor (0.1.1)
    const freshNote = async () => {
        const known = new Set(windows.keys());
        gtkApp.activate_action('new-note', null);
        await sleep(600);
        const nid = [...windows.keys()].find(k => !known.has(k));
        return [nid, windows.get(nid)];
    };
    const future = () => new Date(Date.now() + 1000).toISOString();

    // every cause of the core has a text of its own (not the general "Not saved"); the dark class is switched both ways
    const general = S.markNotSaved('NO_SUCH_CAUSE');
    check(Object.keys(CAUSE).every(code => S.markNotSaved(code) !== general), 'every core cause has its own "not saved" text');
    w.setDark(true);
    check(w.win.has_css_class('cetli-dark'), 'dark theme adds the cetli-dark class');
    w.setDark(false);
    check(!w.win.has_css_class('cetli-dark'), 'and light removes it');

    // coalescing: keys 60 ms apart are ONE write
    const [id3, w3] = await freshNote();
    const rev0 = fileRec(id3).rev;
    for (const t of ['a', 'b', 'c']) {
        w3.buffer.insert_at_cursor(t, -1);
        await sleep(60);
    }
    await sleep(500);
    check(fileRec(id3).text === 'abc' && fileRec(id3).rev === rev0 + 1, `three keys 60 ms apart are one write (rev ${rev0} -> ${fileRec(id3).rev})`);

    // the 2 s quiet rule: saved and clean, but a key 1 s ago: a remote version waits, then it is taken with its colour
    w3.buffer.insert_at_cursor('d', -1);
    await sleep(450);
    check(!w3._dirty() && fileRec(id3).text === 'abcd', 'the key was saved: the window is clean');
    const startColor3 = w3.color;
    const remoteColor = NOTE_COLOR_IDS.find(c => c !== startColor3);
    remoteWrite(id3, {rev: fileRec(id3).rev + 1, updated: future(), device: 'b5b5b5b5', text: 'abcd REMOTE', color: remoteColor});
    await sleep(700);
    check(w3._bufferText() === 'abcd' && w3.mark?.kind === 'newer', 'a clean window with a key 1 s ago keeps its text and shows the mark');
    check(w3.color === startColor3 && !w3.win.has_css_class(`cetli-${remoteColor}`), 'and its colour');
    await sleep(1700);
    check(w3._bufferText() === 'abcd REMOTE' && w3.mark === null, 'after 2 s without a key the remote text is taken, the mark goes');
    check(w3.color === remoteColor && w3.win.has_css_class(`cetli-${remoteColor}`) && !w3.win.has_css_class(cssClassOf(startColor3)), 'the colour of the remote version is applied');

    // a cursor exactly at the start of the changed region stays before the new text
    w3.buffer.place_cursor(w3.buffer.get_iter_at_offset(4));
    remoteWrite(id3, {rev: fileRec(id3).rev + 1, updated: future(), device: 'b5b5b5b5', text: 'abcdXYZ REMOTE', color: remoteColor});
    await sleep(900);
    check(w3._bufferText() === 'abcdXYZ REMOTE', `the text was inserted (${w3._bufferText()})`);
    const at = m => w3.buffer.get_iter_at_mark(m).get_offset();
    check(at(w3.buffer.get_insert()) === 4 && at(w3.buffer.get_selection_bound()) === 4, `a cursor at the start of the region stays before the new text (${at(w3.buffer.get_insert())})`);

    // a refused save: the file is dated 30 h ahead (quarantine). The typed text stays in the window, even for 2 s of quiet.
    const quarantine = nid => remoteWrite(nid, {rev: fileRec(nid).rev + 1, updated: new Date(Date.now() + 30 * 3600000).toISOString(), device: 'b5b5b5b5', text: 'from the future'});
    const [id4, w4] = await freshNote();
    quarantine(id4);
    await sleep(800);
    w4.buffer.insert_at_cursor('typed', -1);
    await sleep(600);
    check(w4.mark?.kind === 'refused' && w4._dirty(), `a quarantined file: the save is refused, the text stays (${w4.mark?.text})`);
    await sleep(2300);
    const filesBefore = noteFiles().length;
    remoteWrite(id4, {rev: fileRec(id4).rev + 1, updated: future(), device: 'b5b5b5b5', text: 'valid remote'});
    await sleep(1000);
    check(w4._bufferText() === 'typed', `an unsaved window never takes the remote text, however quiet it is (${w4._bufferText()})`);
    check(fileRec(id4).text === 'typed' && w4.mark === null && !w4._dirty(), 'the retried save wrote the typed text, cleared the mark, and the window is clean');
    check(noteFiles().length === filesBefore + 1, `the remote version was kept as a copy (${filesBefore} -> ${noteFiles().length} files)`);

    // closing a window whose refused save left the text only in the window: the first close warns, the second one closes
    const [id5, w5] = await freshNote();
    quarantine(id5);
    await sleep(800);
    w5.buffer.insert_at_cursor('unsaved', -1);
    await sleep(600);
    check(w5.mark?.kind === 'refused', 'refused again');
    w5.win.close();
    await sleep(300);
    check(windows.has(id5) && w5.win.get_visible() && w5.mark?.text === S.markCloseUnsaved(), `the first close only warns (${w5.mark?.text})`);
    w5.win.close();
    await sleep(500);
    check(!windows.has(id5), 'the second close closes the window');

    // About
    const before = Gtk.Window.list_toplevels().length;
    w.ctl.showAbout(w.win);
    await sleep(300);
    check(Gtk.Window.list_toplevels().length === before + 1, 'About opens as an extra window');
    // libadwaita before 1.5 shows an Adw.AboutWindow (a toplevel with `comments`); the 1.5 dialog is not a toplevel
    const about = Gtk.Window.list_toplevels().find(t => typeof t.comments === 'string');
    if (about) {
        check(about.comments === `${S.aboutComments()}` && about.comments.includes('\n\nThe code of this project was written with the help of AI agents.'),
            'the About text ends with the AI-agents sentence in a paragraph of its own (decision A5)');
    } else {
        print('SKIP the About comments are not readable here (Adw.AboutDialog is not a toplevel)');
    }

    // delete (menu action win.delete)
    w.win.lookup_action('delete').activate(null);
    await sleep(600);
    check(fileRec(id).deleted === true && fileRec(id).text === '', 'delete writes a tombstone');
    check(!windows.has(id), 'deleted note: window closed');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
