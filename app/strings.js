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
    case 'freeze': return _('Stopping additions from other computers');
    case 'remove': return _('Removing the computers');
    case 'verify': return _('Checking the removal');
    case 'dwell': return _('Waiting to see whether one comes back');
    default: return '';
    }
}

export const syncIdsTitle = () => _('Connect two computers');
export const syncOwnIdHeading = () => _('This computer');
export const syncOwnIdHint = () => _('To connect, enter this ID on the other computer. This window waits for it.');
// A computer with no other computer yet: where to start, and what joining means (the typing field is only on this page).
export const syncNewStart = () => _("To add this computer to a group, open cetli on a computer that is already in the group and press Add a computer there. Then enter that computer's ID here.");
export const syncGuestNote = () => _('This computer will join the group of the other computer. The other computers of that group will appear here without asking you.');
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
export const syncAcceptNote = () => _('Once accepted, this computer can also add other computers to your group, without asking you again.');
// The sentence about the accepted computer and the exception (Nicole, verbatim): on the accept card and in the footnote of the group page.
export const syncTrustSentence = () => _('A computer you accept can add other computers to your group without asking you again. Remove a lost computer on all your computers.');

export const syncConnectingTitle = () => _('Connecting…');
export const syncConnectingText = () => _('The other computer must also have the ID of this computer entered, and its sync window must be open. This is the ID of this computer:');

export const syncDoneTitle = () => _('Connected');
export const syncDoneText = name => fill(_('Connected to %s.'), name);
// "Connected for N seconds": N is what the engine itself watched (about 9), a lower bound, not the age of the link.
export const syncDoneSeconds = n => fill(_('Connected for %s seconds.'), String(n));
export const syncDonePeerId = () => _('ID of the other computer:');
// Translators: the quoted words are the names of the texts and the button in this window, keep them the same as the translations of
// "Connected", "This computer" and "Stop syncing".
export const syncCheckOther = () => _('Now open cetli on the other computer. It must also say Connected. If it does not, or if the ID shown here is not the one the other computer shows as This computer, press Stop syncing here.');

// ---- the group (0.2.6): one row per computer ----
export const syncGroupTitle = () => _('Your computers');
export const syncGroupCount = (n, max) => fill(_('%s / %s computers'), String(n), String(max));
export const syncAddButton = () => _('Add a computer');
export const syncRowAccepted = () => _('You accepted this computer');
export const syncRowThrough = (name, idStart) => fill(_('Added through %s (ID starts %s)'), name, idStart);
export const syncRowGone = () => _('Added through a computer that is no longer here');
export const syncRowLimited = () => _('Limited: nothing is taken over from it');
export const syncRowSameName = () => _('Another computer in the list has the same name. Compare the ID.');
export function syncLinkText(key) {
    switch (key) {
    case 'connected': return _('Connected');
    case 'unstable': return _('The connection is not confirmed yet');
    case 'offline': return _('Not connected right now');
    default: return '';
    }
}
// A neutral note under the status (no red, no button): the listener state of `status`. Only `degraded` and `down` are shown.
export function syncListenerText(state) {
    switch (state) {
    case 'degraded': return _('This computer could not open its sync port. Connecting may still work, but may take longer.');
    case 'down': return _('The sync program does not answer right now.');
    default: return '';
    }
}
export const syncGroupFull = max => fill(_('This group already has %s computers. Remove one first.'), String(max));
export const syncOverLimit = (n, max) => fill(_('This group has %s computers, more than the %s that cetli allows. New computers cannot be added until you remove some.'), String(n), String(max));
export const syncNewBanner = n => fill(_('%s computers were added to your group since you last looked. Check that you know all of them.'), String(n));
export const syncNewAllMine = () => _('They are all mine');
export const syncNewNotMine = () => _('Not mine, remove');
export const syncPromoteNote = () => _('Allow this for the computers you already accepted? A pair of computers needs your Allow on both of them: do it on this computer and on the other one too.');
export const syncPromoteAllow = () => _('Allow');
export const syncPromoteLater = () => _('Not now');
export const syncFreezeBanner = () => _('A removal is not finished on this computer. New computers cannot be added until you press Finish.');
export const syncReturned = idStart => fill(_('A removed computer is back (ID starts %s). Remove it again?'), idStart);
export const syncRemovedBanner = idStart => fill(_('A computer you removed here (ID starts %s). Add it again only if you recognise it; you still compare its ID and accept it.'), idStart);
export const syncReaddButton = () => _('Add again');
export const syncRemoveButton = () => _('Remove');
export const syncShowOwnId = () => _('Show the ID of this computer');
export const syncStopShort = () => _('Stop syncing');
export const syncStopAll = () => _('Stop syncing with all computers');
export const syncStopConfirmBody = () => _('Your notes stay on all your computers. They will not be exchanged any more.');

// ---- removing a computer ----
export const syncRemoveTitle = () => _('Remove a computer');
export const syncRemoveHave = () => _('I still have this computer');
export const syncRemoveHaveDetail = () => _('Syncing with it stops on this computer. Its notes stay on it. Computers that got it through this one drop it too.');
export const syncRemoveLost = () => _('It is lost or stolen, or I do not know it');
export const syncRemoveLostDetail = () => _('cetli first stops this computer from taking anything over from the others, then removes the computer. After that you must do the same on each of your other computers.');
export const syncRemoveOthers = () => _('Also remove these, if they are not yours:');
export const syncRemoveTooMany = max => fill(_('Select at most %s computers at once.'), String(max));
export const syncRevokingTitle = () => _('Removing…');
export const syncRevokeRemoved = list => fill(_('Removed on this computer: %s. Your notes can still reach it through other computers that have not removed it yet.'), list);
export const syncRevokeOffline = list => fill(_('These computers were offline just now: %s. If one of them still knows the removed computer, it can bring it back to every computer that has not done this removal yet. It cannot bring it back here while this computer is limited. Open cetli on it and do the same there.'), list);
export const syncRevokeNext = () => _('To be sure, open this list on each of your other computers and choose the same action there. Press Finish here only when you have done it everywhere: the permissions come back on only at the next reconnection, and if the removed computer is still listed on any computer, it brings the removed computer back. Until then this computer takes no additions from other computers.');
export const syncFinishButton = () => _('Finish: I did this on all my computers');
export const syncFinishShort = () => _('Finish');

export const syncInfoStfolderTitle = () => _('Sync is already set up here');
export const syncInfoStfolderText = () => _('The notes of this computer are already synchronised by another Syncthing. cetli leaves it exactly as it is, and your sync keeps working as you set it up.');
export const syncInfoStfolderHint = () => _('If that Syncthing does not sync this folder any more, delete the hidden folder .stfolder inside the notes folder and open this window again.');
export const syncInfoForeignTitle = () => _('Nothing was changed');
export const syncInfoForeignText = () => _('The sync program of cetli contains a computer or a folder that was not set up here. cetli leaves everything as it is and shows no connection.');

export const syncErrorTitle = () => _('Sync did not work');
// The text of an error code. Information codes (a neutral page) are the same function; the window decides the look.
export function syncErrorText(code, max = null) {
    switch (code) {
    case 'E_NO_SYNCTHING': return _('Syncthing is not installed on this computer.');
    case 'E_NO_USER_SYSTEMD': return _('The background service could not be started: this session has no user service manager.');
    case 'E_SERVICE_TIMEOUT': return _('Sync was started but does not answer. Try again. To see the log, run: journalctl --user -u cetli-syncthing');
    case 'E_CONFIG_UNSAFE': return _('The sync settings could not be prepared safely. Nothing was changed.');
    case 'E_CLI_FAILED': return _('The sync program refused a step. Try again.');
    case 'E_STFOLDER_EXISTS': return syncInfoStfolderText();
    case 'E_ALREADY_PAIRED': return _('This computer is already set up with another computer. Stop syncing with it first.');
    case 'E_HALF_STATE_OTHER': return _('This computer is set up for a different computer. Stop syncing with it first.');
    case 'E_PEER_TIMEOUT': return _('Still waiting. The other computer must also have the ID of this computer entered, and its sync window must be open; then check that the ID shown there is right. A firewall on either computer can also be the cause: the ports are TCP and UDP 22100 and UDP 21127. A connection through a relay may still come up, but may take longer.') + ' ' + _('If the other computer says its group is full, remove a computer there first.');
    case 'E_EXPIRED': return _('Stopped waiting after 15 minutes.');
    case 'E_PENDING_TOO_LARGE': return _('Too many connection attempts were seen to judge them safely. Nothing was accepted.');
    case 'E_PENDING_AMBIGUOUS': return _('More than one computer is knocking. Close this window and try again.');
    case 'E_GROUP_FULL': return syncGroupFull(max);
    case 'E_REVOCATION_OPEN': return syncFreezeBanner();
    case 'E_FOREIGN_DEVICE': return _('A computer that was not added here is listed in the sync program of cetli. Nothing was connected.');
    case 'E_BUSY': return _('Another sync step is still running.');
    default: return _('Something went wrong, see the log.');
    }
}
