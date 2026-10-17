// SPDX-License-Identifier: GPL-3.0-or-later
// Headless smoke test of the formatting bar of a note window (app/format-bar.js, app/window.js). Run it like gtk-smoke.js, inside a
// headless Wayland compositor: headless.sh 1920x1080 -- gjs -m app-tests/format-bar-smoke.js
// It drives the real application.js with the real core and the real Gio layer in a temporary XDG tree, and reads the note FILE back.
// NOT exercised: real key events (the accelerators and the actions are checked, not a key press), a real screen reader.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {createApp} from '../app/application.js';
import {FORMAT_ACTIONS, rangesOfRecord, sameRanges, sha16} from '../app/format-bar.js';
import {NoteWindow} from '../app/window.js';
import * as S from '../app/strings.js';

const base = GLib.dir_make_tmp('cetli-fmt-XXXXXX');
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
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
// The save runs in the core's queue; wait (up to 12 s) for what the file should say instead of guessing a fixed time.
const waitFor = async cond => {
    for (let i = 0; i < 120 && !cond(); i++)
        await sleep(100);
};
const readText = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const fileText = id => readText(`${dirs.notes}/${id}.json`);
const fileRec = id => JSON.parse(fileText(id));
// What Syncthing does: a hidden tmp file, then a rename.
function remoteWrite(id, patch) {
    const rec = {...fileRec(id), ...patch};
    const tmp = `${dirs.notes}/.syncthing.${id}.json.tmp`;
    GLib.file_set_contents(tmp, `${JSON.stringify(rec)}\n`);
    Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(`${dirs.notes}/${id}.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
}
const future = ms => new Date(Date.now() + ms).toISOString();
const marks = id => fileRec(id).marks;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Gtk warnings (a CSS rule the parser does not know, ...) are collected: a rule of the bar must parse.
const warnings = [];
GLib.log_set_handler('Gtk', GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL | GLib.LogLevelFlags.LEVEL_MESSAGE,
    (_d, _l, message) => warnings.push(message));


// A key press that goes through the compositor to the focused window (mutter RemoteDesktop), or null when the service is not there.
function realKeys() {
    try {
        const bus = Gio.DBus.session;
        const iface = 'org.gnome.Mutter.RemoteDesktop';
        const call = (path, i, method, params) => bus.call_sync(iface, path, i, method, params, null, Gio.DBusCallFlags.NONE, 3000, null);
        const session = call('/org/gnome/Mutter/RemoteDesktop', iface, 'CreateSession', null).deepUnpack()[0];
        const sessionIface = `${iface}.Session`;
        call(session, sessionIface, 'Start', null);
        const notify = (sym, down) => call(session, sessionIface, 'NotifyKeyboardKeysym', new GLib.Variant('(ub)', [sym, down]));
        return {
            press(...syms) {
                syms.forEach(k => notify(k, true));
                [...syms].reverse().forEach(k => notify(k, false));
            },
            close() {
                try {
                    call(session, sessionIface, 'Stop', null);
                } catch {}
            },
        };
    } catch (e) {
        return null;
    }
}

const ctl = createApp({dirs});

// The text and the formatting of a window as `[text, ranges]`.
const select = (w, a, b) => w.buffer.select_range(w.buffer.get_iter_at_offset(a), w.buffer.get_iter_at_offset(b));
const press = (w, flag) => w.bar.buttons.get(flag).set_active(!w.bar.buttons.get(flag).get_active());
const BOLD = 1, ITALIC = 2, UNDERLINE = 4, STRIKE = 8;

async function scenario() {
    await ctl.ready;
    const [id, w] = [...ctl.windows][0];
    const known = Object.keys(fileRec(id)).join();           // the keys of a plain note, in the order of the file

    // ---- the hash (formatting contract 1): same as node's sha256, on ASCII, astral and combined text
    check(sha16('abc') === 'ba7816bf8f01cfea', 'sha16("abc") is the first 16 hex of the sha256');
    check(sha16('a😀b😀c') === '3b0fa9d763b5cb38', 'sha16 of an astral text is the sha256 of its UTF-8 (node reference)');
    check(sha16('héllo wörld 🎉 end\nsecond line') === '3ce5d8cfc7a21360', 'sha16 of a text with accents, an emoji and a newline (node reference, John\'s probe seed)');

    // ---- the bar
    check(w.bar.widget.get_parent() !== null && w.bar.widget.get_parent().get_last_child() === w.bar.widget, 'the bar is the last row of the note, under the mark label');
    const buttons = [...w.bar.buttons.values()];
    check(buttons.length === 4 && buttons.every(b => b instanceof Gtk.ToggleButton), 'four toggle buttons');
    check([...w.bar.buttons.keys()].join() === '1,2,4,8', 'in the order bold, italic, underline, strikethrough');
    check(buttons.every(b => b.get_focus_on_click() === false), 'a click on a button does not take the focus from the text (the selection stays)');
    check(buttons.map(b => b.get_child().get_label()).join() === '<b>a</b>,<i>a</i>,<u>a</u>,<s>a</s>', 'each button shows an "a" in the form it switches');
    check(buttons.every(b => b.get_tooltip_text().includes(S.formatUndoNote())), 'every tooltip says that Ctrl+Z does not undo formatting');
    check(buttons[0].get_tooltip_text().startsWith(S.formatBoldTooltip()) && buttons[3].get_tooltip_text().startsWith('Strikethrough (Ctrl+Shift+X)'), 'the tooltips carry the keys');
    check(buttons.every(b => !b.get_sensitive() && !b.get_active()), 'without a selection the buttons are off and cannot be pressed');
    check(ctl.gtkApp.get_accels_for_action('win.fmt-bold').join() === '<Control>b' && ctl.gtkApp.get_accels_for_action('win.fmt-italic').join() === '<Control>i' &&
        ctl.gtkApp.get_accels_for_action('win.fmt-underline').join() === '<Control>u' && ctl.gtkApp.get_accels_for_action('win.fmt-strike').join() === '<Shift><Control>x',
        'Ctrl+B, Ctrl+I, Ctrl+U and Ctrl+Shift+X are the accelerators of the four window actions');
    check(FORMAT_ACTIONS.every(a => w.win.lookup_action(a.name) !== null), 'every window has the four actions');
    const tag = flag => w.bar.tags.get(flag);
    check(tag(BOLD).weight === 700 && tag(ITALIC).style === Pango.Style.ITALIC && tag(UNDERLINE).underline === Pango.Underline.SINGLE && tag(STRIKE).strikethrough === true,
        'the four tags are bold, italic, underlined and struck through');

    // ---- a plain note: no marks key, byte for byte what it was
    w.buffer.insert_at_cursor('plain note', -1);
    await waitFor(() => fileRec(id).text === 'plain note');
    check(fileRec(id).text === 'plain note' && Object.keys(fileRec(id)).join() === known, 'a plain note is saved without a `marks` key (the same keys as before)');
    const plainRev = fileRec(id).rev;

    // ---- bold on a selection (code point offsets, astral text)
    w.buffer.set_text('a😀b😀c', -1);
    await waitFor(() => fileRec(id).text === 'a😀b😀c');
    select(w, 1, 4);
    check(buttons.every(b => b.get_sensitive()) && buttons.every(b => !b.get_active()), 'a selection enables the buttons, all off on unformatted text');
    press(w, BOLD);
    await waitFor(() => fileRec(id).marks !== undefined && !w._dirty());
    check(same(marks(id), {h: '3b0fa9d763b5cb38', r: [[1, 4, 1]]}), `bold on "😀b😀" is stored in code points, hash of the text (${JSON.stringify(marks(id))})`);
    check(fileRec(id).text === 'a😀b😀c', 'the text did not change');
    select(w, 1, 4);                  // (the selection of a headless window collapses by itself within 100 ms, also without this code)
    check(w.bar.buttons.get(BOLD).get_active() && !w.bar.buttons.get(ITALIC).get_active(), 'the bold button shows the state of the selection');
    check(same(w.bar.ranges(), [[1, 4, 1]]) && same(w.shownRanges, [[1, 4, 1]]), 'the window\'s ranges are the stored ones');
    check(!w._dirty(), 'after the save the window is clean');

    // ---- more formats on the same and another selection, toggled off again
    select(w, 2, 5);
    press(w, ITALIC);
    await waitFor(() => same(marks(id)?.r, [[1, 2, 1], [2, 4, 3], [4, 5, 2]]));
    check(same(marks(id).r, [[1, 2, 1], [2, 4, 3], [4, 5, 2]]), `bold and italic overlap into flags 3 (${JSON.stringify(marks(id).r)})`);
    select(w, 1, 5);
    check(w.bar.buttons.get(BOLD).get_active() === false && w.bar.buttons.get(ITALIC).get_active() === false, 'a mixed selection: the buttons are off');
    press(w, BOLD);
    await waitFor(() => same(marks(id)?.r, [[1, 2, 1], [2, 5, 3]]));
    check(same(marks(id).r, [[1, 2, 1], [2, 5, 3]]), `a mixed selection: the button puts bold on all of it (${JSON.stringify(marks(id).r)})`);
    select(w, 1, 5);
    check(w.bar.buttons.get(BOLD).get_active(), 'and the button now shows it');
    press(w, BOLD);
    await waitFor(() => same(marks(id)?.r, [[2, 5, 2]]));
    check(same(marks(id).r, [[2, 5, 2]]), `when all of the selection has it, the button takes it away (${JSON.stringify(marks(id).r)})`);
    select(w, 2, 5);
    check(w.bar.buttons.get(ITALIC).get_active(), 'the italic button shows italic on 2..5');
    press(w, ITALIC);
    await waitFor(() => fileRec(id).marks === undefined);
    check(w.bar.ranges().length === 0 && fileRec(id).marks === undefined, 'no formatting left: the `marks` key is removed from the file');
    check(Object.keys(fileRec(id)).join() === known, 'the keys are the plain ones again');

    // ---- typing into a formatted range changes the stored offsets and the hash (the tags move with the text)
    w.buffer.set_text('hello world', -1);
    await waitFor(() => fileRec(id).text === 'hello world');
    select(w, 6, 11);
    press(w, UNDERLINE);
    await waitFor(() => fileRec(id).marks !== undefined);
    check(same(marks(id), {h: sha16('hello world'), r: [[6, 11, 4]]}), 'underline on "world"');
    w.buffer.insert(w.buffer.get_iter_at_offset(8), 'XX', -1);
    await waitFor(() => fileRec(id).text === 'hello woXXrld');
    check(same(marks(id), {h: sha16('hello woXXrld'), r: [[6, 13, 4]]}), `a text typed inside the range is formatted too, the hash follows the text (${JSON.stringify(marks(id))})`);
    w.buffer.insert(w.buffer.get_iter_at_offset(0), '>> ', -1);
    await waitFor(() => fileRec(id).text === '>> hello woXXrld');
    check(same(marks(id), {h: sha16('>> hello woXXrld'), r: [[9, 16, 4]]}), 'text typed before the range shifts it');
    w.buffer.delete(w.buffer.get_iter_at_offset(9), w.buffer.get_iter_at_offset(16));
    await waitFor(() => fileRec(id).text === '>> hello ');
    check(fileRec(id).marks === undefined, 'the formatted text deleted: the marks are gone, not left stale');

    // ---- a formatting step alone is a change (no `changed` signal for it) and a colour change keeps the marks
    w.buffer.set_text('format only', -1);
    await waitFor(() => fileRec(id).text === 'format only');
    const revBefore = fileRec(id).rev;
    select(w, 0, 6);
    press(w, STRIKE);
    check(w._dirty(), 'a formatting step makes the window dirty');
    await waitFor(() => fileRec(id).marks !== undefined);
    check(fileRec(id).rev === revBefore + 1 && same(marks(id), {h: sha16('format only'), r: [[0, 6, 8]]}), 'and is saved (rev +1, text the same)');
    const text0 = fileText(id);
    const other = w.color === 'pink' ? 'green' : 'pink';       // the core picked the colour of the note at random
    w.setColor(other);
    await waitFor(() => fileRec(id).color === other);
    check(same(marks(id), {h: sha16('format only'), r: [[0, 6, 8]]}) && fileRec(id).text === 'format only', 'a colour change keeps the marks');
    check(text0 !== fileText(id), 'and wrote the file once more');

    // ---- Ctrl+Z does not undo a formatting
    w.buffer.set_text('undo probe', -1);
    await waitFor(() => fileRec(id).text === 'undo probe');
    select(w, 0, 4);
    press(w, BOLD);
    check(!w.buffer.get_can_undo() || w.bar.ranges().length === 1, 'a tag change is not on the undo stack');
    if (w.buffer.get_can_undo())
        w.buffer.undo();
    check(w.bar.ranges().some(r => r[2] & BOLD) || w.buffer.get_char_count() === 0, 'undo does not take the bold away (the tooltip says so)');
    await waitFor(() => !w._dirty());

    // ---- the key actions
    w.buffer.set_text('keys', -1);
    await waitFor(() => fileRec(id).text === 'keys');
    select(w, 0, 4);
    w.win.activate_action('fmt-italic', null);
    check(w.bar.ranges().some(r => r[2] & ITALIC), 'the action behind Ctrl+I puts italic on the selection');
    w.win.activate_action('fmt-italic', null);
    check(!w.bar.ranges().some(r => r[2] & ITALIC), 'and a second time takes it away');
    w.buffer.place_cursor(w.buffer.get_iter_at_offset(2));
    w.win.activate_action('fmt-bold', null);
    check(w.bar.ranges().length === 0, 'without a selection a key does nothing');
    await waitFor(() => !w._dirty());

    // ---- REAL key presses, sent to the compositor (mutter's RemoteDesktop on the session bus), to the text view that has the focus:
    // the accelerators work while the view has the focus, and the view's own key bindings do not take them (the text stays).
    const remote = realKeys();
    if (remote === null) {
        print('info real key presses: org.gnome.Mutter.RemoteDesktop not available here; NOT measured');
    } else {
        w.win.present();
        w.view.grab_focus();
        await sleep(500);
        w.buffer.set_text('hello world', -1);
        remote.press(0xffe1);                 // a Shift press first: the first key event of a new session is dropped (measured)
        await sleep(200);
        const CTRL = 0xffe3, SHIFT = 0xffe1;
        for (const [label, syms, want] of [['Ctrl+B', [CTRL, 0x62], [[0, 5, 1]]], ['Ctrl+I', [CTRL, 0x69], [[0, 5, 3]]], ['Ctrl+U', [CTRL, 0x75], [[0, 5, 7]]],
            ['Ctrl+Shift+X', [CTRL, SHIFT, 0x78], [[0, 5, 15]]]]) {
            select(w, 0, 5);
            remote.press(...syms);
            await waitFor(() => same(w.bar.ranges(), want));
            check(same(w.bar.ranges(), want) && w._bufferText() === 'hello world', `${label} as a real key press formats the selection and the text view keeps its text (${JSON.stringify(w.bar.ranges())})`);
        }
        select(w, 0, 5);
        remote.press(CTRL, 0x62);
        await waitFor(() => !w.bar.ranges().some(r => r[2] & BOLD));
        check(!w.bar.ranges().some(r => r[2] & BOLD), 'Ctrl+B a second time takes bold away');
        w.buffer.set_text('', -1);
        remote.press(0x78);
        await waitFor(() => w._bufferText() === 'x');
        check(w._bufferText() === 'x', 'a plain key press still types (the key events reach the text view)');
        remote.close();
        await waitFor(() => !w._dirty());
    }

    // ---- paste is plain text
    const clipboard = Gdk.Display.get_default().get_clipboard();
    w.buffer.set_text('0123456789', -1);
    await waitFor(() => fileRec(id).text === '0123456789');
    select(w, 0, 5);
    press(w, BOLD);
    await waitFor(() => fileRec(id).marks !== undefined);
    clipboard.set_content(Gdk.ContentProvider.new_for_value('PASTED'));
    w.buffer.place_cursor(w.buffer.get_iter_at_offset(5));       // at the END of the bold range
    w.view.emit('paste-clipboard');
    await waitFor(() => w._bufferText() === '01234PASTED56789');
    check(w._bufferText() === '01234PASTED56789', 'a paste inserts the text of the clipboard at the cursor');
    check(same(w.bar.ranges(), [[0, 5, 1]]), `a paste at the end of a formatted range is not formatted (${JSON.stringify(w.bar.ranges())})`);
    // the formatted contents of the note itself come back as text only
    select(w, 0, 5);
    w.view.emit('copy-clipboard');
    // (no waiting: after about 300 ms the headless compositor drops the selection of a window that has no keyboard focus; the paste reads at once)
    w.buffer.place_cursor(w.buffer.get_end_iter());
    w.view.emit('paste-clipboard');
    await waitFor(() => w._bufferText() === '01234PASTED5678901234');
    check(w._bufferText() === '01234PASTED5678901234', `the bold text copied from the note comes back as text (${JSON.stringify(w._bufferText())})`);
    check(same(w.bar.ranges(), [[0, 5, 1]]), `and the pasted copy is not bold (${JSON.stringify(w.bar.ranges())})`);
    await waitFor(() => !w._dirty());

    // ---- a record with marks is shown formatted; a stale or malformed one is shown plain (the old-client case)
    w.buffer.set_text('héllo 🎉 old client', -1);
    await waitFor(() => fileRec(id).text === 'héllo 🎉 old client');
    const goodText = 'héllo 🎉 old client';
    remoteWrite(id, {rev: fileRec(id).rev + 1, updated: future(1000), device: 'b5b5b5b5', text: goodText,
        marks: {h: sha16(goodText), r: [[0, 5, 1], [6, 7, 2]]}});
    await waitFor(() => w.bar.ranges().length === 2);
    check(same(w.bar.ranges(), [[0, 5, 1], [6, 7, 2]]) && same(w.shownRanges, [[0, 5, 1], [6, 7, 2]]), 'a version from the other computer with marks: the tags follow it (astral offsets)');
    check(w._bufferText() === goodText, 'the text is the text of the file');
    check(w._saveTimer === null && !w._dirty(), 'applying the marks of the other computer is not a user change (no save is scheduled, the window is clean)');
    // an old client rewrote the text and wrote the marks back unchanged
    const staleText = 'héllo 🎉 EDITED by an old client';
    const staleMarks = {h: sha16(goodText), r: [[0, 5, 1], [6, 7, 2]]};
    remoteWrite(id, {rev: fileRec(id).rev + 1, updated: future(2000), device: 'b5b5b5b5', text: staleText, marks: staleMarks});
    await waitFor(() => w._bufferText() === staleText);
    check(w._bufferText() === staleText && w.bar.ranges().length === 0, 'stale hash (an old client edited the text): the note is shown plain, the text is the new one');
    check(!w._dirty(), 'and the window is clean (the stale marks in the file are not our change)');
    await sleep(500);
    check(same(fileRec(id).marks, staleMarks), 'nothing was written back over the stale marks by just showing them');
    // a colour-only change by the old client keeps text and hash valid: formatting stays
    remoteWrite(id, {rev: fileRec(id).rev + 1, updated: future(3000), device: 'b5b5b5b5', text: goodText, color: 'green', marks: {h: sha16(goodText), r: [[0, 5, 8]]}});
    await waitFor(() => w.bar.ranges().length === 1);
    check(same(w.bar.ranges(), [[0, 5, 8]]) && w.color === 'green', 'a remote version with only the colour and marks changed is applied');
    // then OUR next text edit replaces the stale/old marks
    w.buffer.insert_at_cursor('!', -1);
    await waitFor(() => fileRec(id).text.endsWith('!'));
    check(same(fileRec(id).marks, {h: sha16(fileRec(id).text), r: [[0, 5, 8]]}), 'our next save writes marks for the current text');

    // malformed marks never throw and never block the note
    const t = fileRec(id).text;
    const hostile = [
        'x', null, 5, [], {}, {h: 'zz', r: [[0, 1, 1]]}, {h: sha16(t), r: 'x'}, {h: sha16(t), r: []}, {h: sha16(t), r: [[0, 1, 99]]},
        {h: sha16(t), r: [[0, 1000, 1]]}, {h: sha16(t), r: [[3, 1, 1]]}, {h: sha16(t), r: [[0, 3, 1], [2, 4, 1]]}, {h: sha16(t), r: [[-1, 3, 1]]},
        {h: sha16(t), r: [[0.5, 3, 1]]}, {h: sha16(t), r: [[0, 3, 1, 7]]}, {h: sha16(t), r: Array.from({length: 257}, (_, i) => [i * 2, i * 2 + 1, 1])},
    ];
    let allPlain = true;
    for (const m of hostile) {
        const rec = {...fileRec(id), v: 'x'};
        rec.extra = new Map([['marks', m]]);
        allPlain = allPlain && rangesOfRecord(rec).length === 0;
    }
    check(allPlain, `${hostile.length} malformed shapes of marks all read as "plain", none throws`);

    // ---- a window opened on a record with marks shows them from the first moment (and a plain record shows none)
    const rec = ctl.store.getNote(id);
    const withMarks = {...rec, extra: new Map([['marks', {h: sha16(rec.text), r: [[0, 2, 4]]}]])};
    const w2 = new NoteWindow({ctl: ctl.ctl, record: withMarks, size: {width: 300, height: 200}});
    check(same(w2.bar.ranges(), [[0, 2, 4]]) && !w2._dirty(), 'opening a record with marks: underline on its first two characters, clean');
    w2.win.close();
    const w3 = new NoteWindow({ctl: ctl.ctl, record: {...rec, extra: new Map([['marks', {h: '0000000000000000', r: [[0, 2, 4]]}]])}, size: {width: 300, height: 200}});
    check(w3.bar.ranges().length === 0 && !w3._dirty(), 'opening a record with a stale hash: plain, clean');
    w3.win.close();
    const w4 = new NoteWindow({ctl: ctl.ctl, record: {...rec, extra: new Map()}, size: {width: 300, height: 200}});
    check(w4.bar.ranges().length === 0 && !w4._dirty(), 'opening a plain record: plain, clean');
    w4.win.close();

    // ---- look: the bar inherits the text colour of the note on every kind of note (a 100 % colour, no alpha on the sign)
    const w5 = w;
    const look = [];
    for (const color of ['yellow', '#ee0000', '#3f3d3c', '#ffffff']) {
        w5.setColor(color);
        await sleep(300);
        const textColor = w5.win.get_style_context().get_color();
        const label = w5.bar.buttons.get(BOLD).get_child().get_style_context().get_color();
        look.push([color, same([textColor.red, textColor.green, textColor.blue, textColor.alpha], [label.red, label.green, label.blue, label.alpha])]);
    }
    check(look.every(([, ok]) => ok), `the "a" has the colour of the note text on all kinds of notes (${look.map(([c, ok]) => `${c}:${ok}`).join(' ')})`);
    check(warnings.length === 0, `no Gtk warning while building the bar (${warnings.slice(0, 2).join(' | ')})`);
    // ---- closing right after a formatting saves it (the window is gone when the queued save runs); w stays open
    await ctl.ctl.newNote(null);
    const [id6, w6] = [...ctl.windows].find(([k]) => k !== id);
    w6.buffer.set_text('close me', -1);
    await waitFor(() => fileRec(id6).text === 'close me');
    // a plain note opened and closed again without an edit: not one byte of its file changes, and no `marks` key appears
    const bytes0 = fileText(id6);
    const w7 = new NoteWindow({ctl: ctl.ctl, record: ctl.store.getNote(id6), size: {width: 300, height: 200}});
    await sleep(800);
    check(w7.bar.ranges().length === 0 && !w7._dirty() && w7.shownRanges.length === 0, 'a plain note opens plain and clean');
    w7.win.close();
    await sleep(800);
    check(fileText(id6) === bytes0 && !bytes0.includes('marks'), 'and closing it without an edit leaves the file byte for byte as it was');
    select(w6, 0, 5);
    press(w6, ITALIC);
    w6.win.close();
    w6.bar.setRanges([]);              // the queued save must still write the formatting of the moment of closing
    await waitFor(() => fileRec(id6).marks !== undefined);
    check(same(fileRec(id6).marks, {h: sha16('close me'), r: [[0, 5, 2]]}), 'a formatting step right before closing is saved');

    check(plainRev > 0, 'sane revision numbers');
}

scenario().then(() => {}, e => { failed++; print(`FAIL exception ${e}\n${e.stack}`); }).finally(() => {
    print(`${checks - failed}/${checks} checks passed`);
    print(failed === 0 ? 'RESULT PASS' : 'RESULT FAIL');
    GLib.spawn_command_line_async(`rm -rf ${base}`);
    ctl.gtkApp.quit();
});
const status = ctl.run([]);
imports.system.exit(failed === 0 ? status : 1);
