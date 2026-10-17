// SPDX-License-Identifier: GPL-3.0-or-later
// EVERY text the user can see is here, behind _() (gettext, domain `cetli`, msgids in English). The core's own texts
// (`cause.text`) are English log texts and are never shown: the app maps `cause.code` to the texts below.
import {bindtextdomain, gettext as _, textdomain} from 'gettext';
import GLib from 'gi://GLib';
import {NOTE_BLACK, NOTE_RHEL_RED, NOTE_WHITE} from './data.js';

// The compiled catalogs are in /usr/share/locale (the RPM). CETLI_LOCALEDIR points a development run at another tree.
bindtextdomain('cetli', GLib.getenv('CETLI_LOCALEDIR') ?? '/usr/share/locale');
textdomain('cetli');

export const menuNewNote = () => _('New note');
export const menuDeleteNote = () => _('Delete note');
export const menuAbout = () => _('About cetli');
export const menuAllNotes = () => _('All notes');
// The title of the "All notes" window (a title of its own: only the note windows are named `cetli-<uuid>`).
export const allNotesTitle = () => _('All notes');
// Translators: shown in the "All notes" list for a note that has no text.
export const emptyNotePreview = () => _('(empty note)');
export const menuTooltip = () => _('Main menu');
export const textViewLabel = () => _('Note text');

export function colorName(color) {
    switch (color) {
    case 'yellow': return _('Yellow');
    case 'green': return _('Green');
    case 'blue': return _('Blue');
    case 'pink': return _('Pink');
    case 'purple': return _('Purple');
    case 'gray': return _('Gray');
    case NOTE_BLACK: return _('Black');
    case NOTE_WHITE: return _('White');
    case NOTE_RHEL_RED: return _('RHEL red');
    default: return color;
    }
}

export const markNewerVersion = () => _('A newer version arrived from the other computer');
export const markDeletedElsewhere = () => _('Deleted on the other computer');
export const markFileGone = () => _('The note file is gone');

// A save the core refused (cause.code of the core). The user keeps the text in the window.
export function markNotSaved(code) {
    switch (code) {
    case 'QUARANTINE': return _('Not saved: the file has a date in the future, waiting');
    case 'NOT_READABLE': return _('Not saved: the note file cannot be read');
    case 'NEWER_SCHEMA': return _('Not saved: the note file needs a newer cetli');
    case 'COPY_PLACE_TAKEN': return _('Not saved: the other version could not be kept');
    case 'COPY_NOT_WRITTEN': return _('Not saved: the other version could not be kept (disk full?)');
    case 'MOVE_FAILED': return _('Not saved: the file could not be written');
    case 'TOO_LARGE': return _('Not saved: the note is too large');
    case 'TOO_MANY': return _('Not saved: too many notes');
    case 'REV_LIMIT': return _('Not saved: revision limit reached');
    // The core refuses a record its own reader would reject (e.g. a wrong clock); the reason is in the log, not for the user.
    case 'BAD_INPUT': return _('Not saved: this note cannot be saved');
    default: return _('Not saved');
    }
}

// The first close of a window whose text a refused save left only in the window.
export const markCloseUnsaved = () => _('Not saved: closing loses this text. Close again to discard it.');

export const unresolvedText = n => _('%d unresolved').replace('%d', String(n));
export const unresolvedTooltip = () => _('Conflicting copies of notes were kept; cetli does not merge them yet');

// Translators: the short description in the About window.
const aboutDescription = () => _('Small notes on the desktop that sync between your computers');

// Translators: how the code was written; shown in the About window below the description.
const aboutAuthorship = () => _('The code of this project was written with the help of AI agents.');

// The About `comments`: the description, then the authorship sentence in a paragraph of its own (decision A5, Jenna 6763).
export const aboutComments = () => `${aboutDescription()}\n\n${aboutAuthorship()}`;

// Custom colour picker in the colour popover.
export const customColorTooltip = () => _('Custom color');
export const customColorTitle = () => _('Choose a color');

// ---- "All notes": search, cards, delete (0.2.2) ----------------------------------------------------------------------
export const searchPlaceholder = () => _('Search notes…');
export const noNotesTitle = () => _('No notes');
export const noNotesText = () => _('After you create notes, they will appear here');
export const noResultsTitle = () => _('No results');
export const noResultsText = () => _('Try a different search');
// Translators: tooltips of the eye button on a card in the "All notes" list: the note window is open / closed now.
export const hideNoteTooltip = () => _('Hide note');
export const showNoteTooltip = () => _('Show note');
export const deleteConfirmTitle = () => _('Delete note?');
export const deleteConfirmBody = () => _('This cannot be undone. To only hide the note, close it instead.');
export const cancelButton = () => _('Cancel');
export const deleteButton = () => _('Delete');
// A delete the core refused (cause.code of the core): shown in the "All notes" window, the card stays.
export const deleteRefused = code => _('The note was not deleted (%s)').replace('%s', String(code ?? '?'));

// The formatting bar (a button works on the selected text; each button shows an "a" and carries these names).
export const formatBarLabel = () => _('Formatting');
export const formatBold = () => _('Bold');
export const formatItalic = () => _('Italic');
export const formatUnderline = () => _('Underline');
export const formatStrikethrough = () => _('Strikethrough');
// Translators: the key combination in the brackets is not translated.
export const formatBoldTooltip = () => _('Bold (Ctrl+B)');
export const formatItalicTooltip = () => _('Italic (Ctrl+I)');
export const formatUnderlineTooltip = () => _('Underline (Ctrl+U)');
export const formatStrikethroughTooltip = () => _('Strikethrough (Ctrl+Shift+X)');
export const formatUndoNote = () => _('Ctrl+Z does not undo formatting.');
