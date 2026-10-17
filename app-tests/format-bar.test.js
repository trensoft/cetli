// SPDX-License-Identifier: GPL-3.0-or-later
// The texts of the formatting bar (no Gtk): in strings.js, in the template and in both catalogs, in Hungarian with accents.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const TEXTS = [
    ['Formatting', 'Formázás'], ['Bold', 'Félkövér'], ['Italic', 'Dőlt'], ['Underline', 'Aláhúzott'], ['Strikethrough', 'Áthúzott'],
    ['Bold (Ctrl+B)', 'Félkövér (Ctrl+B)'], ['Italic (Ctrl+I)', 'Dőlt (Ctrl+I)'], ['Underline (Ctrl+U)', 'Aláhúzott (Ctrl+U)'],
    ['Strikethrough (Ctrl+Shift+X)', 'Áthúzott (Ctrl+Shift+X)'], ['Ctrl+Z does not undo formatting.', 'A Ctrl+Z a formázást nem vonja vissza.'],
];

test('formatting bar: every text is in strings.js, the template and both catalogs; the Hungarian one is filled in, with accents', () => {
    const strings = read('app/strings.js');
    for (const [en, hu] of TEXTS) {
        const esc = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(strings, new RegExp(`_\\('${esc}'\\)`), `${en} in strings.js`);
        assert.match(read('po/cetli.pot'), new RegExp(`msgid "${esc}"\\nmsgstr ""`), `${en} in cetli.pot`);
        assert.match(read('po/en.po'), new RegExp(`msgid "${esc}"\\nmsgstr ""`), `${en} in en.po`);
        assert.ok(read('po/hu.po').includes(`msgid "${en}"\nmsgstr "${hu}"`), `${en} in hu.po is "${hu}"`);
    }
});

test('formatting bar: the tooltips name the keys that the accelerators have, and the texts have no long dash', () => {
    const fb = read('app/format-bar.js');
    for (const [key, text] of [['<Control>b', 'Ctrl+B'], ['<Control>i', 'Ctrl+I'], ['<Control>u', 'Ctrl+U'], ['<Control><Shift>x', 'Ctrl+Shift+X']])
        assert.ok(fb.includes(`accel: '${key}'`) && TEXTS.some(([en]) => en.includes(text)), `${text} is the accelerator ${key} and is in a tooltip`);
    for (const [en, hu] of TEXTS)
        assert.ok(!/[–—]/.test(en + hu), `no long dash in ${en}`);
});
