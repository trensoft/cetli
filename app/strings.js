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
// Translators: the title in the header of a red note, meaning "this note matters" (not "urgent", not "a famous person").
export const importantTitle = () => _('Important');

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

// ---- "Sync with another computer" (0.2.5) ----------------------------------------------------------------------------
// The engine's own words never reach the window: only its codes, mapped here. A name from the other computer is shown as plain text
// (`fill` puts the values in by splitting the template, so a `$&` or a `%s` inside a name stays literal).
const fill = (template, ...values) => {
    const parts = template.split('%s');
    return parts.map((p, i) => p + (i < parts.length - 1 ? String(values[i] ?? '') : '')).join('');
};
export const menuSync = () => _('Sync…');
export const syncTitle = () => _('Sync with another computer');
export const syncChecking = () => _('Checking…');
export const syncCheckAgain = () => _('Check again');
export const syncCopy = () => _('Copy');
export const syncCopied = () => _('Copied');
export const syncCancel = () => _('Cancel');
export const syncLater = () => _('Later');
export const syncTryAgain = () => _('Try again');
export const syncClose = () => _('Close');

export const syncMissingTitle = () => _('Syncthing is not installed');
export const syncMissingText = () => _('Sync needs the Syncthing program, and it is not installed on this computer. Install it with the commands below, then press Check again. cetli does not run them for you.');
// The commands are not translated; the window only shows them and offers to copy them.
export const syncInstallCommands = 'sudo dnf install https://dl.fedoraproject.org/pub/epel/epel-release-latest-10.noarch.rpm\nsudo dnf install syncthing';

export const syncConsentTitle = () => _('Set up sync');
export const syncConsentText = () => _('This starts Syncthing as a background service for your user and keeps it running at every login. Your computers find each other through public Syncthing servers and relays, which learn that the computers exist (device ID and IP address) but not your notes: those are encrypted between your computers. cetli opens a network port and announces itself on the local network. Nothing is changed until you press the button.');
export const syncConsentButton = () => _('Set up sync on this computer');

export const syncSettingUp = () => _('Setting up…');
export function syncStepText(step) {
    switch (step) {
    case 'instance': return _('Preparing the sync program');
    case 'folder': return _('Adding the notes folder');
    case 'service': return _('Starting the background service');
    case 'device': return _('Adding the other computer');
    case 'share': return _('Sharing the notes');
    case 'connect': return _('Connecting');
    case 'sync': return _('Waiting for the notes');
    default: return '';
    }
}

export const syncIdsTitle = () => _('Connect two computers');
export const syncOwnIdHeading = () => _('This computer');
export const syncOwnIdHint = () => _('To connect, enter this ID on the other computer. This window waits for it.');
export const syncCopyId = () => _('Copy the ID');
export const syncWaiting = () => _('Waiting for the other computer…');
export const syncEnterIdHeading = () => _('Or enter the ID shown on the other computer');
export const syncEnterIdPlaceholder = () => _('ID of the other computer');
export const syncConnectButton = () => _('Connect');
export const syncPasteHint = () => _('Paste the ID with Ctrl+V');
export const syncBadId = () => _('This is not a valid ID. Check it and try again.');
export const syncOwnIdEntered = () => _('This is the ID of this computer. Enter the ID of the other computer.');
export const syncCandidateTitle = () => _('Another computer wants to connect');
export const syncNameUnreadable = () => _('(name not readable)');
export const syncCandidateName = name => fill(_('Name: %s'), name);
export const syncCompareText = () => _('Accept only if the other computer shows the same ID. Compare at least the first two groups.');
export const syncAcceptButton = (name, group) => fill(_('Accept %s (ID starts %s)'), name, group);

export const syncConnectingTitle = () => _('Connecting…');
export const syncConnectingText = () => _('The other computer must also have the ID of this computer entered, and its sync window must be open. This is the ID of this computer:');

export const syncDoneTitle = () => _('Connected');
export const syncDoneText = name => fill(_('Connected to %s.'), name);
export const syncDonePeerId = () => _('ID of the other computer:');
// Translators: the quoted words are the names of the texts and the button in this window, keep them the same as the translations of
// "Connected", "This computer" and "Stop syncing".
export const syncCheckOther = () => _('Now open cetli on the other computer. It must also say Connected. If it does not, or if the ID shown here is not the one the other computer shows as This computer, press Stop syncing here.');

export const syncPairedTitle = () => _('Sync');
export function syncLinkText(key) {
    switch (key) {
    case 'connected': return _('Connected');
    case 'catching-up': return _('Connected, the notes are still arriving');
    case 'unstable': return _('The connection is unstable');
    case 'offline': return _('Not connected right now');
    case 'checking': return _('Checking the connection…');
    default: return '';
    }
}
export const syncPeerHeading = () => _('Other computer');
export const syncShowOwnId = () => _('Show the ID of this computer');
export const syncStop = () => _('Stop syncing with this computer');
export const syncStopShort = () => _('Stop syncing');
export const syncStopConfirmTitle = () => _('Stop syncing with this computer?');
export const syncStopConfirmBody = () => _('Your notes stay on both computers. They will not be exchanged any more.');
export const syncHalfTitle = () => _('Not finished');
export const syncHalfText = () => _('This computer was set up to connect to another computer, but the connection was never completed. Stop syncing, then start again.');

export const syncInfoStfolderTitle = () => _('Sync is already set up here');
export const syncInfoStfolderText = () => _('The notes of this computer are already synchronised by another Syncthing. cetli leaves it exactly as it is, and your sync keeps working as you set it up.');
export const syncInfoStfolderHint = () => _('If that Syncthing does not sync this folder any more, delete the hidden folder .stfolder inside the notes folder and open this window again.');
export const syncInfoForeignTitle = () => _('Nothing was changed');
export const syncInfoForeignText = () => _('The sync program of cetli lists a computer that was not added here. cetli leaves everything as it is and shows no connection.');

export const syncErrorTitle = () => _('Sync did not work');
// The text of an error code. Information codes (a neutral page) are the same function; the window decides the look.
export function syncErrorText(code) {
    switch (code) {
    case 'E_NO_SYNCTHING': return _('Syncthing is not installed on this computer.');
    case 'E_NO_USER_SYSTEMD': return _('The background service could not be started: this session has no user service manager.');
    case 'E_SERVICE_TIMEOUT': return _('Sync was started but does not answer. Try again. To see the log, run: journalctl --user -u cetli-syncthing');
    case 'E_CONFIG_UNSAFE': return _('The sync settings could not be prepared safely. Nothing was changed.');
    case 'E_CLI_FAILED': return _('The sync program refused a step. Try again.');
    case 'E_STFOLDER_EXISTS': return syncInfoStfolderText();
    case 'E_ALREADY_PAIRED': return _('This computer is already set up with another computer. Stop syncing with it first.');
    case 'E_HALF_STATE_OTHER': return _('This computer is set up for a different computer. Stop syncing with it first.');
    case 'E_PEER_TIMEOUT': return _('Still waiting. The other computer must also have the ID of this computer entered, and its sync window must be open; then check that the ID shown there is right. A firewall on either computer can also be the cause: the ports are TCP and UDP 22100 and UDP 21127. A connection through a relay may still come up, but may take longer.');
    case 'E_NOT_UP_TO_DATE': return _('The computers are connected, but the notes have not arrived yet.');
    case 'E_EXPIRED': return _('Stopped waiting after 15 minutes.');
    case 'E_PENDING_TOO_LARGE': return _('Too many connection attempts were seen to judge them safely. Nothing was accepted.');
    case 'E_PENDING_AMBIGUOUS': return _('More than one computer is knocking. Close this window and try again.');
    case 'E_FOREIGN_DEVICE': return _('A computer that was not added here is listed in the sync program of cetli. Nothing was connected.');
    case 'E_BUSY': return _('Another sync step is still running.');
    default: return _('Something went wrong, see the log.');
    }
}
