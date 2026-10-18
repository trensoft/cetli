// SPDX-License-Identifier: GPL-3.0-or-later
// The "Sync with another computer" window (PLAN-WIZARD 2.3, 0H, 0H.2). A thin front end: it asks the bridge for the engine's verbs and shows
// what the engine says; it holds nothing of Syncthing, starts nothing itself, and every text comes from strings.js. The ID of this computer
// is shown in full; the other computer's ID is typed or pasted as text and sent to the engine untouched (the engine checks it).
// While this window sits on the ID page a `host` run waits for the other computer; entering an ID stops it (a machine is host OR guest).
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {BACKEND_EXE} from '../sync/paths.js';
import {joinStdin} from '../sync/protocol.js';
import {buttonGroup, compareLine, errorView, idRows, idsReducer, initialIdsState, linkKey, pageForStatus} from './sync-flow.js';
import * as S from './strings.js';

const ID_FIELD_MAX = 100;

const mono = label => {
    label.add_css_class('monospace');
    return label;
};

export class SyncWizard {
    // ctl: {gtkApp, log(text), onSyncClosed(win), dismissSync() (writes the "Later" state)}; bridge: SyncBridge or a fake with
    // start(verb, opts) -> {done, accept(id), stop()}, run(verb, opts), stop(). firstStart: open at the consent page without any engine
    // call (PLAN-WIZARD 0H.11 rule 1); a missing Syncthing program still shows its own page.
    constructor({ctl, bridge, firstStart = false, binaryExists = () => Gio.File.new_for_path(BACKEND_EXE).query_exists(null)}) {
        this.ctl = ctl;
        this.bridge = bridge;
        this.firstStart = firstStart;
        this.binaryExists = binaryExists;
        this.ownId = null;
        this.hostRun = null;
        this.hostGeneration = 0;
        this.ids = initialIdsState;
        this.status = null;
        this.closed = false;
        this.retry = null;
        this.w = {};
        this.win = new Gtk.ApplicationWindow({application: ctl.gtkApp, title: S.syncTitle(), default_width: 480, default_height: 600});
        this.win.add_css_class('cetli-sync');
        this.stack = new Gtk.Stack({vexpand: true, hexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE});
        this.toasts = new Adw.ToastOverlay({child: this.stack});
        this.win.set_child(this.toasts);
        this._buildPages();
        this.win.connect('close-request', () => {
            this._onClose();
            return false;
        });
    }

    present() {
        this.win.present();
        if (this._opened)
            return;
        this._opened = true;
        if (this.firstStart)
            this._openFirstStart();
        else
            this.refresh();
    }

    get page() {
        return this.stack.get_visible_child_name();
    }

    // ---- pages ----------------------------------------------------------------------------------------------------------

    _addPage(name, widgets) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 18, margin_bottom: 18, margin_start: 18, margin_end: 18, valign: Gtk.Align.CENTER});
        for (const w of widgets)
            box.append(w);
        const page = new Gtk.ScrolledWindow({child: new Adw.Clamp({child: box, maximum_size: 460}), hscrollbar_policy: Gtk.PolicyType.NEVER});
        this.stack.add_named(page, name);
        return box;
    }

    _title(text) {
        const l = new Gtk.Label({label: text, wrap: true, xalign: 0, use_markup: false});
        l.add_css_class('title-2');
        return l;
    }

    _text(text = '') {
        return new Gtk.Label({label: text, wrap: true, xalign: 0, use_markup: false, selectable: false});
    }

    _button(text, handler, suggested = false) {
        const b = new Gtk.Button({label: text, halign: Gtk.Align.START});
        if (suggested)
            b.add_css_class('suggested-action');
        b.connect('clicked', handler);
        return b;
    }

    // The ID in two monospace rows, selectable.
    _idLabels() {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
        const rows = [mono(new Gtk.Label({label: '', xalign: 0, selectable: true, use_markup: false})), mono(new Gtk.Label({label: '', xalign: 0, selectable: true, use_markup: false}))];
        for (const r of rows)
            box.append(r);
        return {box, set: id => { const [a, b] = id ? idRows(id) : ['', '']; rows[0].set_label(a); rows[1].set_label(b); }, rows};
    }

    _buildPages() {
        const w = this.w;
        // checking
        w.checkingLabel = this._text(S.syncChecking());
        this._addPage('checking', [new Gtk.Spinner({spinning: true, halign: Gtk.Align.CENTER, width_request: 32, height_request: 32}), w.checkingLabel]);

        // missing (E1)
        w.missingText = this._text(S.syncMissingText());
        w.missingCommands = mono(new Gtk.Label({label: S.syncInstallCommands, xalign: 0, selectable: true, wrap: true, use_markup: false}));
        w.missingCopy = this._button(S.syncCopy(), () => this._copy(S.syncInstallCommands));
        w.missingCheck = this._button(S.syncCheckAgain(), () => this.refresh(), true);
        const missingButtons = new Gtk.Box({spacing: 6});
        missingButtons.append(w.missingCopy);
        missingButtons.append(w.missingCheck);
        this._addPage('missing', [this._title(S.syncMissingTitle()), w.missingText, w.missingCommands, missingButtons]);

        // consent
        w.consentText = this._text(S.syncConsentText());
        w.consentButton = this._button(S.syncConsentButton(), () => this._setup(), true);
        w.consentLater = this._button(S.syncLater(), () => this.win.close());
        const consentButtons = new Gtk.Box({spacing: 6});
        consentButtons.append(w.consentButton);
        consentButtons.append(w.consentLater);
        this._addPage('consent', [this._title(S.syncConsentTitle()), w.consentText, consentButtons]);

        // setup
        w.setupStep = this._text('');
        this._addPage('setup', [this._title(S.syncSettingUp()), new Gtk.Spinner({spinning: true, halign: Gtk.Align.START, width_request: 24, height_request: 24}), w.setupStep]);

        // ids
        w.ownIdHeading = this._title(S.syncIdsTitle());
        w.ownIdCaption = this._text(S.syncOwnIdHeading());
        w.ownIdCaption.add_css_class('heading');
        w.ownId = this._idLabels();
        w.ownIdCopy = this._button(S.syncCopyId(), () => this._copy(this.ownId ?? ''));
        w.ownIdHint = this._text(S.syncOwnIdHint());
        w.waiting = this._text(S.syncWaiting());
        w.spinner = new Gtk.Spinner({spinning: true, halign: Gtk.Align.START});
        const waitBox = new Gtk.Box({spacing: 8});
        waitBox.append(w.spinner);
        waitBox.append(w.waiting);
        // the candidate card (hidden until exactly one computer knocks)
        w.candTitle = this._title(S.syncCandidateTitle());
        w.candName = this._text('');
        w.candId = this._idLabels();
        w.candCompare = this._text(S.syncCompareText());
        w.candAccept = this._button('', () => this._accept(), true);
        w.cand = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, visible: false});
        w.cand.add_css_class('card');
        for (const c of [w.candTitle, w.candName, w.candId.box, w.candCompare, w.candAccept])
            w.cand.append(c);
        w.enterHeading = this._text(S.syncEnterIdHeading());
        w.enterHeading.add_css_class('heading');
        w.entry = new Gtk.Entry({placeholder_text: S.syncEnterIdPlaceholder(), max_length: ID_FIELD_MAX, hexpand: true});
        w.entry.update_property([Gtk.AccessibleProperty.LABEL], [S.syncEnterIdHeading()]);
        w.entry.connect('changed', () => this._onEntryChanged());
        w.entry.connect('activate', () => this._connect());
        w.connect = this._button(S.syncConnectButton(), () => this._connect(), true);
        w.connect.set_sensitive(false);
        const entryRow = new Gtk.Box({spacing: 6});
        entryRow.append(w.entry);
        entryRow.append(w.connect);
        w.entryError = this._text('');
        w.entryError.add_css_class('error');
        w.entryError.set_visible(false);
        w.idsListener = this._text('');
        w.idsListener.set_visible(false);
        this._addPage('ids', [w.ownIdHeading, w.ownIdCaption, w.ownId.box, w.ownIdCopy, w.ownIdHint, waitBox, w.cand, w.enterHeading, entryRow, w.entryError, w.idsListener]);

        // connecting
        w.connStep = this._text('');
        w.connText = this._text(S.syncConnectingText());
        w.connOwnId = this._idLabels();
        w.connCancel = this._button(S.syncCancel(), () => this._cancelConnect());
        this._addPage('connecting', [this._title(S.syncConnectingTitle()), new Gtk.Spinner({spinning: true, halign: Gtk.Align.START}), w.connText, w.connOwnId.box, w.connStep, w.connCancel]);

        // done
        w.doneTitle = this._title(S.syncDoneTitle());
        w.doneText = this._text('');
        w.doneSeconds = this._text('');
        w.donePeerCaption = this._text(S.syncDonePeerId());
        w.donePeerId = this._idLabels();
        w.doneCheck = this._text(S.syncCheckOther());
        w.doneClose = this._button(S.syncClose(), () => this.win.close(), true);
        this._addPage('done', [w.doneTitle, w.doneText, w.doneSeconds, w.donePeerCaption, w.donePeerId.box, w.doneCheck, w.doneClose]);

        // paired (page S)
        w.pairedPeer = this._text('');
        w.pairedLink = this._text('');
        w.pairedListener = this._text('');
        w.pairedPeerId = this._idLabels();
        w.pairedOwnCaption = this._text(S.syncOwnIdHeading());
        w.pairedOwnCaption.add_css_class('heading');
        w.pairedOwnId = this._idLabels();
        w.pairedShowOwn = this._button(S.syncShowOwnId(), () => this._togglePairedOwn());
        w.pairedStop = this._button(S.syncStop(), () => this._confirmStop());
        w.pairedClose = this._button(S.syncClose(), () => this.win.close());
        w.pairedOwn = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, visible: false});
        w.pairedOwn.append(w.pairedOwnCaption);
        w.pairedOwn.append(w.pairedOwnId.box);
        this._addPage('paired', [this._title(S.syncPairedTitle()), w.pairedLink, w.pairedListener, w.pairedPeer, w.pairedPeerId.box, w.pairedShowOwn, w.pairedOwn, w.pairedStop, w.pairedClose]);

        // half
        w.halfStop = this._button(S.syncStopShort(), () => this._confirmStop(), true);
        this._addPage('half', [this._title(S.syncHalfTitle()), this._text(S.syncHalfText()), w.halfStop]);

        // neutral information (nothing is wrong): the .stfolder case and a foreign entry
        w.infoStfolderClose = this._button(S.syncClose(), () => this.win.close());
        const hint = this._text(S.syncInfoStfolderHint());
        hint.add_css_class('dim-label');
        hint.add_css_class('caption');
        this._addPage('info-stfolder', [this._title(S.syncInfoStfolderTitle()), this._text(S.syncInfoStfolderText()), hint, w.infoStfolderClose]);
        w.infoForeignClose = this._button(S.syncClose(), () => this.win.close());
        this._addPage('info-foreign', [this._title(S.syncInfoForeignTitle()), this._text(S.syncInfoForeignText()), w.infoForeignClose]);

        // error (red) or information (neutral, from an information code)
        w.errTitle = this._title('');
        w.errText = this._text('');
        w.errAction = this._button('', () => this._onErrorAction(), true);
        w.errSecondary = this._button('', () => this._onErrorSecondary());
        w.errClose = this._button(S.syncClose(), () => this.win.close());
        w.errButtons = new Gtk.Box({spacing: 6});
        w.errButtons.append(w.errAction);
        w.errButtons.append(w.errClose);
        this._addPage('error', [w.errTitle, w.errText, w.errButtons, w.errSecondary]);
    }

    _show(name) {
        this.stack.set_visible_child_name(name);
    }

    _copy(text) {
        try {
            const bytes = GLib.Bytes.new(new TextEncoder().encode(text));
            this.win.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes));
            this.toasts.add_toast(new Adw.Toast({title: S.syncCopied(), timeout: 2}));
        } catch (e) {
            this.ctl.log(`sync: copy failed: ${e?.message ?? e}`);
        }
    }

    // ---- flow -----------------------------------------------------------------------------------------------------------

    async refresh() {
        if (this.closed)
            return;
        this._show('checking');
        const out = await this.bridge.run('status');
        if (this.closed)
            return;
        if (!out.ok) {
            // A computer that was set up reconnects by itself: the first time the sync program does not answer in this window, it is started
            // again once, without a click (no data is touched). If that does not help, the buttons follow. Never a loop (see _restart).
            if (out.error.code === 'E_SERVICE_TIMEOUT' && !this.restartTried) {
                this._restart();
                return;
            }
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this.status = out.result;
        this._showForStatus(out.result);
    }

    // The first start: the consent page, no engine call (rule 1 of 0H.11). Without the Syncthing program the page for that is shown.
    _openFirstStart() {
        this._show(this.binaryExists() ? 'consent' : 'missing');
    }

    _showForStatus(result) {
        const page = pageForStatus(result);
        if (page === 'ids') {
            this.ownId = result.own_id;
            this._enterIds();
            this._setListenerNote(this.w.idsListener, result);
        } else if (page === 'paired') {
            this.ownId = result.own_id;
            this._fillPaired(result);
            this._show('paired');
        } else if (page === 'half') {
            this._show('half');
        } else if (page === 'error') {
            this._showError('E_INTERNAL', () => this.refresh());
        } else {
            this._show(page);
        }
    }

    _fillPaired(result) {
        const w = this.w;
        const name = result.peer?.name ?? S.syncNameUnreadable();
        w.pairedPeer.set_label(`${S.syncPeerHeading()}: ${name}`);
        w.pairedPeerId.set(result.peer?.id ?? '');
        w.pairedLink.set_label(S.syncLinkText(linkKey(result)));
        this._setListenerNote(w.pairedListener, result);
        w.pairedOwnId.set(result.own_id ?? '');
        w.pairedOwn.set_visible(false);
    }

    // A neutral line (no error style) for a listener that is `degraded` or `down`; empty and hidden otherwise.
    _setListenerNote(label, result) {
        const text = S.syncListenerText(result?.listener);
        label.set_label(text);
        label.set_visible(text !== '');
    }

    _togglePairedOwn() {
        this.w.pairedOwn.set_visible(!this.w.pairedOwn.get_visible());
    }

    async _setup() {
        this._show('setup');
        this.w.setupStep.set_label('');
        const out = await this.bridge.run('setup', {onEvent: ev => {
            if (ev.event === 'progress' && ev.state === 'start')
                this.w.setupStep.set_label(S.syncStepText(ev.step));
        }});
        if (this.closed)
            return;
        if (!out.ok) {
            this._showError(out.error.code, () => this._setup());
            return;
        }
        this.ownId = out.result.own_id;
        this._enterIds();
    }

    // The ID page: this computer's ID in full, a waiting `host`, the field for the other computer's ID.
    _enterIds(message = null) {
        const w = this.w;
        w.ownId.set(this.ownId ?? '');
        this.ids = initialIdsState;
        this.acceptSent = false;
        w.cand.set_visible(false);
        w.entryError.set_visible(message !== null);
        w.idsListener.set_visible(false);
        w.entryError.set_label(message ?? '');
        w.entry.set_sensitive(true);
        this._onEntryChanged();
        this._show('ids');
        this._startHost();
    }

    _startHost() {
        const generation = ++this.hostGeneration;
        const run = this.bridge.start('host', {onEvent: ev => {
            if (generation !== this.hostGeneration || this.closed)
                return;
            this.ids = idsReducer(this.ids, ev);
            if (ev.event === 'candidate') {
                this._showCandidate(this.ids.candidate);
            } else if (ev.event === 'peer' || ev.event === 'progress') {
                if (this.page === 'connecting' || ev.event === 'peer')
                    this._showConnecting(ev);
            }
        }});
        this.hostRun = run;
        run.done.then(out => {
            if (generation !== this.hostGeneration || this.closed)
                return;
            this.hostRun = null;
            if (out.ok) {
                this._showDone(out.result.peer, out.result.connected_s);
            } else {
                this._showError(out.error.code, this._retryFor(out.error.code));
            }
        });
    }

    // After the other computer was added, "Try again" must not start a second opening (the engine would refuse: this computer is already set
    // up with another one): it asks the status again, which shows the half-finished state with "Stop syncing".
    _retryFor(code) {
        return code === 'E_PEER_TIMEOUT' ? () => this.refresh() : () => this._enterIds();
    }

    _showCandidate(c) {
        const w = this.w;
        const name = c.name ?? S.syncNameUnreadable();
        w.candName.set_label(S.syncCandidateName(name));
        w.candId.set(c.id);
        w.candAccept.set_label(S.syncAcceptButton(name, buttonGroup(c.id)));
        w.candAccept.set_sensitive(true);
        w.cand.set_visible(true);
        w.candCompare.set_tooltip_text(compareLine(c.id));
    }

    _accept() {
        const c = this.ids.candidate;
        if (!c || !this.hostRun || this.acceptSent)
            return;
        if (this.hostRun.accept(c.id)) {
            this.acceptSent = true;                                  // ONE accept per opening
            this.w.candAccept.set_sensitive(false);
            this._showConnecting({event: 'progress', step: 'device', state: 'start'});
        }
    }

    // The guest shows its own ID the moment it starts connecting (0H.2 1): the user compares it with what the host shows.
    _showConnecting(ev) {
        const w = this.w;
        w.connOwnId.set(this.ownId ?? '');
        if (ev.event === 'progress')
            w.connStep.set_label(S.syncStepText(ev.step));
        this._show('connecting');
    }

    _onEntryChanged() {
        const text = this.w.entry.get_text();
        this.w.connect.set_sensitive(text.trim().length > 0 && text.length <= ID_FIELD_MAX);
        if (this.w.entryError.get_visible() && !this._keepEntryError) {
            this.w.entryError.set_visible(false);
        }
    }

    // Enter the other computer's ID: the waiting run ends (a machine is host OR guest), then `join` gets the line as typed.
    async _connect() {
        const typed = this.w.entry.get_text();
        const line = joinStdin(typed);
        if (line === null || typed.trim().length === 0)
            return;
        this.w.connect.set_sensitive(false);
        this.w.entry.set_sensitive(false);
        this.hostGeneration++;
        if (this.hostRun) {
            const run = this.hostRun;
            this.hostRun = null;
            await run.stop();
        }
        if (this.closed)
            return;
        this._showConnecting({event: 'progress', step: 'device', state: 'start'});
        const generation = this.hostGeneration;
        this.joinRun = this.bridge.start('join', {stdin: line, onEvent: ev => {
            if (generation !== this.hostGeneration || this.closed)
                return;
            if (ev.event === 'progress')
                this._showConnecting(ev);
        }});
        const out = await this.joinRun.done;
        this.joinRun = null;
        if (this.closed || generation !== this.hostGeneration)
            return;
        if (out.ok) {
            this._showDone(out.result.peer, out.result.connected_s);
        } else if (out.error.code === 'E_BAD_ID' || out.error.code === 'E_OWN_ID') {
            this._keepEntryError = true;
            this._enterIds(out.error.code === 'E_BAD_ID' ? S.syncBadId() : S.syncOwnIdEntered());
            this._keepEntryError = false;
        } else {
            this._showError(out.error.code, this._retryFor(out.error.code));
        }
    }

    _cancelConnect() {
        this.hostGeneration++;
        const run = this.joinRun ?? this.hostRun;
        this.joinRun = null;
        this.hostRun = null;
        const finish = () => { if (!this.closed) this._enterIds(); };
        if (run)
            run.stop().then(finish, finish);
        else
            finish();
    }

    _showDone(peer, connectedS) {
        const w = this.w;
        w.doneText.set_label(S.syncDoneText(peer?.name ?? S.syncNameUnreadable()));
        w.doneSeconds.set_label(Number.isInteger(connectedS) ? S.syncDoneSeconds(connectedS) : '');
        w.donePeerId.set(peer?.id ?? '');
        this._show('done');
    }

    _confirmStop() {
        const dialog = new Adw.MessageDialog({transient_for: this.win, modal: true, heading: S.syncStopConfirmTitle(), body: S.syncStopConfirmBody()});
        dialog.add_response('cancel', S.syncCancel());
        dialog.add_response('stop', S.syncStopShort());
        dialog.set_response_appearance('stop', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'stop')
                this._forget();
        });
        this.confirmDialog = dialog;
        dialog.present();
    }

    async _forget() {
        this._show('checking');
        const out = await this.bridge.run('forget');
        if (this.closed)
            return;
        if (!out.ok) {
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this.refresh();
    }

    // The sync program does not answer: start it again (no data is touched), then ask the status. One automatic try per window (restartTried):
    // a click on the button counts as that try too, so a click never makes a second restart behind it.
    async _restart() {
        this.restartTried = true;
        this._show('checking');
        const out = await this.bridge.run('restart');
        if (this.closed)
            return;
        if (!out.ok) {
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this.refresh();
    }

    // The last way out: this computer gets a new ID, the other computer has to stop syncing too, the notes stay. The text says so before the click.
    _confirmReset() {
        const dialog = new Adw.MessageDialog({transient_for: this.win, modal: true, heading: S.syncResetConfirmTitle(), body: S.syncResetConfirmBody()});
        dialog.add_response('cancel', S.syncCancel());
        dialog.add_response('reset', S.syncResetButton());
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'reset')
                this._reset();
        });
        this.confirmDialog = dialog;
        dialog.present();
    }

    // `reset` puts the instance aside and answers without the sync program; then the window starts from the beginning: a new ID, the ID page.
    async _reset() {
        this._show('checking');
        const out = await this.bridge.run('reset');
        if (this.closed)
            return;
        if (!out.ok) {
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this._setup();
    }

    // ---- errors ---------------------------------------------------------------------------------------------------------

    // `retry`: what "Try again" does. An information code is a neutral page: no red, no "Try again".
    _showError(code, retry) {
        const view = errorView(code);
        const w = this.w;
        this.retry = retry;
        this.errAction = view.action;
        w.errTitle.set_label(view.neutral ? S.syncTitle() : S.syncErrorTitle());
        w.errText.set_label(S.syncErrorText(view.code));
        for (const cls of ['error', 'cetli-error'])
            w.errText.remove_css_class(cls);
        if (!view.neutral)
            w.errText.add_css_class('cetli-error');
        const label = {retry: S.syncTryAgain(), restart: S.syncTryAgain(), check: S.syncCheckAgain(), stop: S.syncStopShort()}[view.action];
        w.errAction.set_visible(label !== undefined);
        if (label !== undefined)
            w.errAction.set_label(label);
        this.errSecondary = view.secondary ?? null;
        w.errSecondary.set_visible(this.errSecondary === 'reset');
        if (this.errSecondary === 'reset')
            w.errSecondary.set_label(S.syncResetButton());
        this._show('error');
    }

    _onErrorAction() {
        if (this.errAction === 'stop')
            this._confirmStop();
        else if (this.errAction === 'check')
            this.refresh();
        else if (this.errAction === 'restart')
            this._restart();
        else if (typeof this.retry === 'function')
            this.retry();
    }

    _onErrorSecondary() {
        if (this.errSecondary === 'reset')
            this._confirmReset();
    }

    // ---- closing --------------------------------------------------------------------------------------------------------

    _onClose() {
        if (this.closed)
            return;
        this.closed = true;
        this.hostGeneration++;
        // On the consent page "Later" (or the close button) is the user's answer: it is written, so the window does not reappear at
        // every start. Anywhere else nothing is written.
        if (this.page === 'consent')
            this.ctl.dismissSync?.();
        this.hostRun?.stop();
        this.joinRun?.stop();
        this.ctl.onSyncClosed?.(this);
    }
}
