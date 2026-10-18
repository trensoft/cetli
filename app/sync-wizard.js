// SPDX-License-Identifier: GPL-3.0-or-later
// The "Sync with another computer" window (PLAN-WIZARD 2.3, 0H, 0H.2; PLAN-0.2.6 5). A thin front end: it asks the bridge for the engine's
// verbs and shows what the engine says; it holds nothing of Syncthing, starts nothing itself, and every text comes from strings.js. The ID
// of this computer is shown in full; the other computer's ID is typed or pasted as text and sent to the engine untouched (the engine checks
// it). While this window sits on the ID page (no other computer yet) or the add page (a group exists) a `host` run waits for the other
// computer; only a computer with no other computer types an ID (a machine is host OR guest, and a group is never merged by typing).
// Every name that comes from the engine is foreign input: it goes into labels with markup off and nowhere else.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {BACKEND_EXE} from '../sync/paths.js';
import {joinStdin} from '../sync/protocol.js';
import {SHORTCUT_REMOVE} from '../sync/policy.js';
import {buttonGroup, compareLine, errorView, forgetId, groupView, idRows, idsReducer, initialIdsState, pageForStatus, removeDefaults, removePaths, revokeIds, revokeSummary} from './sync-flow.js';
import * as S from './strings.js';

const ID_FIELD_MAX = 100;

const mono = label => {
    label.add_css_class('monospace');
    return label;
};

export class SyncWizard {
    // ctl: {gtkApp, log(text), onSyncClosed(win), dismissSync() (writes the "Later" state)}; bridge: SyncBridge or a fake with
    // start(verb, opts) -> {done, accept(id), stop()}, run(verb, opts), stop(). firstStart: open at the consent page without any engine
    // call (PLAN-WIZARD 0H.11 rule 1); a missing Syncthing program still shows its own page. shortcutRemove: the policy switch of the
    // "I still have this computer" path (only the tests give another value).
    constructor({ctl, bridge, firstStart = false, binaryExists = () => Gio.File.new_for_path(BACKEND_EXE).query_exists(null), shortcutRemove = SHORTCUT_REMOVE}) {
        this.ctl = ctl;
        this.bridge = bridge;
        this.firstStart = firstStart;
        this.shortcutRemove = shortcutRemove;
        this.binaryExists = binaryExists;
        this.ownId = null;
        this.hostRun = null;
        this.hostGeneration = 0;
        this.ids = initialIdsState;
        this.status = null;
        this.closed = false;
        this.retry = null;
        this.mode = 'ids';                  // 'ids' (no other computer yet, may type) or 'add' (a group exists, only waits)
        this.view = null;                   // groupView of the status on the group page
        this.rowWidgets = [];
        this.foreignRowWidgets = [];
        this.returnedRows = [];
        this.rm = null;                     // the remove page: {id, path, marked}
        this.revokeStatus = null;           // the status the last `revoke` was chosen from
        this.promoteDismissed = false;
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

        // ids (no other computer yet: the field to type is here) and add (a group exists: the same page without the field)
        this.sets = {ids: this._waitingPage('ids', true), add: this._waitingPage('add', false)};
        Object.assign(w, this.sets.ids);
        this.u = this.sets.ids;

        // connecting
        w.connStep = this._text('');
        w.connText = this._text(S.syncConnectingText());
        w.connOwnId = this._idLabels();
        w.connGuest = this._text(S.syncGuestNote());
        w.connGuest.set_visible(false);
        w.connCancel = this._button(S.syncCancel(), () => this._cancelConnect());
        this._addPage('connecting', [this._title(S.syncConnectingTitle()), new Gtk.Spinner({spinning: true, halign: Gtk.Align.START}), w.connText, w.connOwnId.box, w.connGuest, w.connStep, w.connCancel]);

        // done
        w.doneTitle = this._title(S.syncDoneTitle());
        w.doneText = this._text('');
        w.doneSeconds = this._text('');
        w.donePeerCaption = this._text(S.syncDonePeerId());
        w.donePeerId = this._idLabels();
        w.doneCheck = this._text(S.syncCheckOther());
        w.doneClose = this._button(S.syncClose(), () => this.win.close(), true);
        this._addPage('done', [w.doneTitle, w.doneText, w.doneSeconds, w.donePeerCaption, w.donePeerId.box, w.doneCheck, w.doneClose]);

        this._buildGroupPage();
        this._buildRemovePages();

        // neutral information (nothing is wrong): the .stfolder case and a foreign entry
        w.infoStfolderClose = this._button(S.syncClose(), () => this.win.close());
        const hint = this._text(S.syncInfoStfolderHint());
        hint.add_css_class('dim-label');
        hint.add_css_class('caption');
        this._addPage('info-stfolder', [this._title(S.syncInfoStfolderTitle()), this._text(S.syncInfoStfolderText()), hint, w.infoStfolderClose]);
        w.infoForeignClose = this._button(S.syncClose(), () => this.win.close());
        // the computers the engine lists next to the foreign entry (no link measured): each can be removed, which the engine allows here
        w.foreignRows = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
        this._addPage('info-foreign', [this._title(S.syncInfoForeignTitle()), this._text(S.syncInfoForeignText()), w.foreignRows, w.infoForeignClose]);

        // error (red) or information (neutral, from an information code)
        w.errTitle = this._title('');
        w.errText = this._text('');
        w.errAction = this._button('', () => this._onErrorAction(), true);
        w.errClose = this._button(S.syncClose(), () => this.win.close());
        w.errButtons = new Gtk.Box({spacing: 6});
        w.errButtons.append(w.errAction);
        w.errButtons.append(w.errClose);
        this._addPage('error', [w.errTitle, w.errText, w.errButtons]);
    }

    // The waiting page. `typing`: the page of a computer with no other computer yet (the field for the other ID, the guest note, where to
    // start); without it this is the add page of a group (a computer with other computers never types an ID: it could merge two groups).
    _waitingPage(name, typing) {
        const u = {};
        u.ownIdHeading = this._title(typing ? S.syncIdsTitle() : S.syncAddButton());
        u.ownIdCaption = this._text(S.syncOwnIdHeading());
        u.ownIdCaption.add_css_class('heading');
        u.ownId = this._idLabels();
        u.ownIdCopy = this._button(S.syncCopyId(), () => this._copy(this.ownId ?? ''));
        u.ownIdHint = this._text(S.syncOwnIdHint());
        u.waiting = this._text(S.syncWaiting());
        u.spinner = new Gtk.Spinner({spinning: true, halign: Gtk.Align.START});
        const waitBox = new Gtk.Box({spacing: 8});
        waitBox.append(u.spinner);
        waitBox.append(u.waiting);
        // the candidate card (hidden until exactly one computer knocks)
        u.candTitle = this._title(S.syncCandidateTitle());
        u.candName = this._text('');
        u.candId = this._idLabels();
        u.candCompare = this._text(S.syncCompareText());
        u.candAccept = this._button('', () => this._accept(), true);
        u.candNote = this._text(S.syncAcceptNote());
        u.candTrust = this._text(S.syncTrustSentence());
        u.candTrust.add_css_class('dim-label');
        u.candTrust.add_css_class('caption');
        u.cand = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, visible: false});
        u.cand.add_css_class('card');
        for (const c of [u.candTitle, u.candName, u.candId.box, u.candCompare, u.candAccept, u.candNote, u.candTrust])
            u.cand.append(c);
        u.idsListener = this._text('');
        u.idsListener.set_visible(false);
        const widgets = [u.ownIdHeading];
        if (typing) {
            u.newStart = this._text(S.syncNewStart());
            widgets.push(u.newStart);
            u.removed = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});         // the computers removed here (after a removal of all)
            widgets.push(u.removed);
        }
        widgets.push(u.ownIdCaption, u.ownId.box, u.ownIdCopy, u.ownIdHint, waitBox, u.cand);
        if (typing) {
            u.enterHeading = this._text(S.syncEnterIdHeading());
            u.enterHeading.add_css_class('heading');
            u.entry = new Gtk.Entry({placeholder_text: S.syncEnterIdPlaceholder(), max_length: ID_FIELD_MAX, hexpand: true});
            u.entry.update_property([Gtk.AccessibleProperty.LABEL], [S.syncEnterIdHeading()]);
            u.entry.connect('changed', () => this._onEntryChanged());
            u.entry.connect('activate', () => this._connect());
            u.connect = this._button(S.syncConnectButton(), () => this._connect(), true);
            u.connect.set_sensitive(false);
            const entryRow = new Gtk.Box({spacing: 6});
            entryRow.append(u.entry);
            entryRow.append(u.connect);
            u.entryError = this._text('');
            u.entryError.add_css_class('error');
            u.entryError.set_visible(false);
            u.guestNote = this._text(S.syncGuestNote());
            u.guestNote.add_css_class('dim-label');
            u.guestNote.add_css_class('caption');
            widgets.push(u.enterHeading, entryRow, u.entryError, u.guestNote);
        } else {
            u.cancel = this._button(S.syncCancel(), () => this._leaveAdd());
            widgets.push(u.cancel);
        }
        widgets.push(u.idsListener);
        this._addPage(name, widgets);
        return u;
    }

    // A banner: text and buttons in a card. Hidden until the group page needs it.
    _banner(buttons = []) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, visible: false, margin_top: 4, margin_bottom: 4});
        box.add_css_class('card');
        const label = this._text('');
        label.set_margin_start(8);
        label.set_margin_end(8);
        label.set_margin_top(8);
        box.append(label);
        const row = new Gtk.Box({spacing: 6, margin_start: 8, margin_end: 8, margin_bottom: 8});
        for (const b of buttons)
            row.append(b);
        box.append(row);
        return {box, label, row};
    }

    // The group page: how many computers, the banners (each only while its flag says so), one row per computer, the buttons.
    _buildGroupPage() {
        const w = this.w;
        w.groupCount = this._text('');
        w.groupCount.add_css_class('heading');
        w.freezeButton = this._button(S.syncFinishButton(), () => this._confirmFinish(), true);
        w.bnFreeze = this._banner([w.freezeButton]);
        w.bnFreeze.label.set_label(S.syncFreezeBanner());
        w.bnOver = this._banner();
        w.bnFull = this._banner();
        w.promoteAllow = this._button(S.syncPromoteAllow(), () => this._promote(), true);
        w.promoteLater = this._button(S.syncPromoteLater(), () => this._promoteLater());
        w.bnPromote = this._banner([w.promoteAllow, w.promoteLater]);
        w.bnPromote.label.set_label(`${S.syncTrustSentence()} ${S.syncPromoteNote()}`);
        w.newAllMine = this._button(S.syncNewAllMine(), () => this._ackNew());
        w.bnNew = this._banner([w.newAllMine]);
        w.bnReturned = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        w.bnRemoved = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        w.groupListener = this._text('');
        w.groupListener.set_visible(false);
        w.groupRows = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
        w.groupAdd = this._button(S.syncAddButton(), () => this._enterAdd(), true);
        w.groupShowOwn = this._button(S.syncShowOwnId(), () => this._toggleGroupOwn());
        w.groupStop = this._button(S.syncStopShort(), () => this._confirmStop());
        w.groupClose = this._button(S.syncClose(), () => this.win.close());
        w.groupOwnCaption = this._text(S.syncOwnIdHeading());
        w.groupOwnCaption.add_css_class('heading');
        w.groupOwnId = this._idLabels();
        w.groupOwn = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, visible: false});
        w.groupOwn.append(w.groupOwnCaption);
        w.groupOwn.append(w.groupOwnId.box);
        w.groupFootnote = this._text(S.syncTrustSentence());
        w.groupFootnote.add_css_class('dim-label');
        w.groupFootnote.add_css_class('caption');
        const buttons = new Gtk.Box({spacing: 6});
        for (const b of [w.groupAdd, w.groupShowOwn, w.groupStop, w.groupClose])
            buttons.append(b);
        this._addPage('group', [this._title(S.syncGroupTitle()), w.groupCount, w.bnFreeze.box, w.bnOver.box, w.bnFull.box, w.bnPromote.box, w.bnNew.box,
            w.bnReturned, w.bnRemoved, w.groupListener, w.groupRows, buttons, w.groupOwn, w.groupFootnote]);
    }

    // The remove page, the page that shows the removal running, and the result page.
    _buildRemovePages() {
        const w = this.w;
        w.removeTarget = this._text('');
        w.removeTarget.add_css_class('heading');
        w.removeHave = new Gtk.CheckButton();
        w.removeHave.set_child(this._text(S.syncRemoveHave()));
        w.removeHaveDetail = this._text(S.syncRemoveHaveDetail());
        w.removeHaveDetail.add_css_class('dim-label');
        w.removeLost = new Gtk.CheckButton();
        w.removeLost.set_child(this._text(S.syncRemoveLost()));
        w.removeLost.set_group(w.removeHave);
        w.removeLost.set_active(true);
        w.removeLostDetail = this._text(S.syncRemoveLostDetail());
        w.removeLostDetail.add_css_class('dim-label');
        w.removeHave.connect('toggled', () => this._onRemovePath());
        w.removeOthersHeading = this._text(S.syncRemoveOthers());
        w.removeOthersHeading.add_css_class('heading');
        w.removeList = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        w.removeOthers = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        w.removeOthers.append(w.removeOthersHeading);
        w.removeOthers.append(w.removeList);
        w.removeTooMany = this._text('');
        w.removeTooMany.add_css_class('error');
        w.removeTooMany.set_visible(false);
        w.removeConfirm = this._button(S.syncRemoveButton(), () => this._confirmRemove());
        w.removeConfirm.add_css_class('destructive-action');
        w.removeBack = this._button(S.syncCancel(), () => this._show(pageForStatus(this.status) === 'info-foreign' ? 'info-foreign' : 'group'));
        const removeButtons = new Gtk.Box({spacing: 6});
        removeButtons.append(w.removeConfirm);
        removeButtons.append(w.removeBack);
        this._addPage('remove', [this._title(S.syncRemoveTitle()), w.removeTarget, w.removeHave, w.removeHaveDetail, w.removeLost, w.removeLostDetail,
            w.removeOthers, w.removeTooMany, removeButtons]);

        // revoking: the steps, no cancel (after the first write there is nothing to take back)
        w.revokeSteps = {};
        const steps = [];
        for (const step of ['freeze', 'remove', 'verify', 'dwell']) {
            const row = new Gtk.Box({spacing: 8});
            const spinner = new Gtk.Spinner({spinning: false, visible: false});
            const done = new Gtk.Image({icon_name: 'emblem-ok-symbolic', visible: false});
            const slot = new Gtk.Box({width_request: 24});
            slot.append(spinner);
            slot.append(done);
            const label = this._text(S.syncStepText(step));
            row.append(slot);
            row.append(label);
            w.revokeSteps[step] = {spinner, done, label};
            steps.push(row);
        }
        this._addPage('revoking', [this._title(S.syncRevokingTitle()), ...steps]);

        // revoke-result: the three blocks of Nicole 2.5 in her order, Finish with its own confirm, the nuclear option
        w.resRemoved = this._text('');
        w.resOffline = this._text('');
        w.resNext = this._text(S.syncRevokeNext());
        w.resReturned = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        w.resFinish = this._button(S.syncFinishButton(), () => this._confirmFinish(), true);
        w.resStopAll = new Gtk.Button({label: S.syncStopAll(), halign: Gtk.Align.START});
        w.resStopAll.add_css_class('flat');
        w.resStopAll.connect('clicked', () => this._confirmStop());
        w.resClose = this._button(S.syncClose(), () => this.win.close());
        const resButtons = new Gtk.Box({spacing: 6});
        resButtons.append(w.resFinish);
        resButtons.append(w.resClose);
        this._addPage('revoke-result', [this._title(S.syncRemoveTitle()), w.resRemoved, w.resOffline, w.resNext, w.resReturned, resButtons, w.resStopAll]);
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

    // `status`; when it reports introduced computers whose flag should be lowered, `harden` once and `status` once more (no loop, and a
    // failing `harden` changes nothing the user sees: the first status is shown).
    async refresh() {
        if (this.closed)
            return;
        this._show('checking');
        let out = await this.bridge.run('status');
        if (this.closed)
            return;
        if (out.ok && out.result.harden_pending > 0) {
            const hardened = await this.bridge.run('harden');
            if (this.closed)
                return;
            if (hardened.ok) {
                out = await this.bridge.run('status');
                if (this.closed)
                    return;
            }
        }
        if (!out.ok) {
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

    _showForStatus(status) {
        const page = pageForStatus(status);
        if (page === 'ids') {
            this.ownId = status.own_id;
            this._enterIds();
            this.removedRows = this._fillRemoved(this.w.removed, groupView(status).removedIds);
            this._setListenerNote(this.w.idsListener, status);
        } else if (page === 'group') {
            this.ownId = status.own_id;
            this._fillGroup(status);
            this._show('group');
        } else if (page === 'info-foreign') {
            this.ownId = status.own_id;
            this.foreignRowWidgets = this._fillRows(this.w.foreignRows, groupView(status));
            this._show(page);
        } else if (page === 'error') {
            this._showError('E_INTERNAL', () => this.refresh());
        } else {
            this._show(page);
        }
    }

    // The group page for a status: the count, the banners that apply, one row per computer.
    _fillGroup(status) {
        const w = this.w;
        const v = groupView(status);
        this.view = v;
        w.groupCount.set_label(v.max === null ? '' : S.syncGroupCount(v.computers, v.max));
        const show = (banner, on, text = null) => {
            banner.box.set_visible(on);
            if (text !== null)
                banner.label.set_label(text);
        };
        show(w.bnFreeze, v.revocationOpen);
        show(w.bnOver, v.overLimit, v.overLimit ? S.syncOverLimit(v.computers, v.max) : null);
        show(w.bnFull, v.full, v.full ? S.syncGroupFull(v.max) : null);
        show(w.bnPromote, v.promoteIds.length > 0 && !this.promoteDismissed);
        show(w.bnNew, v.newIds.length > 0, v.newIds.length > 0 ? S.syncNewBanner(v.newIds.length) : null);
        this._fillReturned(v);
        this.removedRows = this._fillRemoved(w.bnRemoved, v.removedIds);
        this.rowWidgets = this._fillRows(w.groupRows, v);
        w.groupAdd.set_sensitive(!v.addBlocked);
        this._setListenerNote(w.groupListener, status);
        w.groupOwnId.set(status.own_id ?? '');
        w.groupOwn.set_visible(false);
    }

    // One banner per computer that came back after it was removed.
    _fillReturned(v) {
        const w = this.w;
        for (let c = w.bnReturned.get_first_child(); c !== null; c = w.bnReturned.get_first_child())
            w.bnReturned.remove(c);
        this.returnedRows = [];
        for (const id of v.returnedIds) {
            const button = this._button(S.syncRemoveButton(), () => this._openRemove(id), true);
            const banner = this._banner([button]);
            banner.label.set_label(S.syncReturned(compareLine(id)));
            banner.box.set_visible(true);
            w.bnReturned.append(banner.box);
            this.returnedRows.push({id, label: banner.label, button});
        }
    }

    // One banner per computer this computer removed that is not in the list: "Add again" lifts the tombstone (`ack`), after that `host`
    // offers the computer when it knocks and the user compares its ID and accepts as for any other. The widgets are returned (the tests read them).
    _fillRemoved(container, ids) {
        for (let c = container.get_first_child(); c !== null; c = container.get_first_child())
            container.remove(c);
        const rows = [];
        for (const id of ids) {
            const button = this._button(S.syncReaddButton(), () => this._runThenRefresh('ack', {ids: [id]}));
            const banner = this._banner([button]);
            banner.label.set_label(S.syncRemovedBanner(compareLine(id)));
            banner.box.set_visible(true);
            container.append(banner.box);
            rows.push({id, label: banner.label, button});
        }
        return rows;
    }

    // One card per computer in `container`; the widgets are returned (the tests read them).
    _fillRows(container, v) {
        for (let c = container.get_first_child(); c !== null; c = container.get_first_child())
            container.remove(c);
        const widgets = [];
        for (const r of v.rows) {
            const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 4, margin_bottom: 4, margin_start: 8, margin_end: 8});
            const row = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 0});
            row.add_css_class('card');
            row.append(card);
            const name = this._text(r.name ?? S.syncNameUnreadable());
            name.add_css_class('heading');
            if (r.isNew || r.returned)
                name.add_css_class('warning');                      // a computer to look at: new since the last look, or back after a removal
            const compare = mono(new Gtk.Label({label: r.compare, xalign: 0, selectable: true, use_markup: false}));
            const how = this._text(r.how.kind === 'accepted' ? S.syncRowAccepted() :
                r.how.kind === 'through' ? S.syncRowThrough(r.how.name ?? S.syncNameUnreadable(), r.how.idStart) : S.syncRowGone());
            const linkText = S.syncLinkText(r.link);
            const link = this._text(linkText);
            link.set_visible(linkText !== '');
            const limited = this._text(S.syncRowLimited());
            limited.set_visible(r.limited);
            const sameName = this._text(S.syncRowSameName());
            sameName.set_visible(r.sameName);
            const remove = this._button(r.isNew ? S.syncNewNotMine() : S.syncRemoveButton(), () => this._openRemove(r.id));
            for (const c of [name, compare, how, link, limited, sameName, remove])
                card.append(c);
            container.append(row);
            widgets.push({id: r.id, name, compare, how, link, limited, sameName, remove});
        }
        return widgets;
    }

    // A neutral line (no error style) for a listener that is `degraded` or `down`; empty and hidden otherwise.
    _setListenerNote(label, status) {
        const text = S.syncListenerText(status?.listener);
        label.set_label(text);
        label.set_visible(text !== '');
    }

    _toggleGroupOwn() {
        this.w.groupOwn.set_visible(!this.w.groupOwn.get_visible());
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

    // The ID page (no other computer yet): this computer's ID in full, a waiting `host`, the field for the other computer's ID.
    _enterIds(message = null) {
        this.mode = 'ids';
        this._enterWaiting(this.sets.ids, message);
    }

    // The add page (a group exists): the same, without the field. This computer waits; the new computer types.
    _enterAdd() {
        this.mode = 'add';
        this._enterWaiting(this.sets.add, null);
    }

    _enterWaiting(u, message) {
        this.u = u;
        u.ownId.set(this.ownId ?? '');
        this.ids = initialIdsState;
        this.acceptSent = false;
        u.cand.set_visible(false);
        u.idsListener.set_visible(false);
        if (u.entry !== undefined) {
            u.entryError.set_visible(message !== null);
            u.entryError.set_label(message ?? '');
            u.entry.set_sensitive(true);
            this._onEntryChanged();
        }
        this._show(this.mode);
        this._startHost();
    }

    // Leave the add page without adding anyone: the waiting run ends, the list is read again.
    _leaveAdd() {
        this.hostGeneration++;
        const run = this.hostRun;
        this.hostRun = null;
        const finish = () => this.refresh();
        if (run)
            run.stop().then(finish, finish);
        else
            finish();
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
        return code === 'E_PEER_TIMEOUT' ? () => this.refresh() : () => (this.mode === 'add' ? this._enterAdd() : this._enterIds());
    }

    _showCandidate(c) {
        const u = this.u;
        const name = c.name ?? S.syncNameUnreadable();
        u.candName.set_label(S.syncCandidateName(name));
        u.candId.set(c.id);
        u.candAccept.set_label(S.syncAcceptButton(name, buttonGroup(c.id)));
        u.candAccept.set_sensitive(true);
        u.cand.set_visible(true);
        u.candCompare.set_tooltip_text(compareLine(c.id));
    }

    _accept() {
        const c = this.ids.candidate;
        if (!c || !this.hostRun || this.acceptSent)
            return;
        if (this.hostRun.accept(c.id)) {
            this.acceptSent = true;                                  // ONE accept per opening
            this.u.candAccept.set_sensitive(false);
            this._showConnecting({event: 'progress', step: 'device', state: 'start'});
        }
    }

    // The guest shows its own ID the moment it starts connecting (0H.2 1): the user compares it with what the host shows.
    _showConnecting(ev, guest = false) {
        const w = this.w;
        w.connOwnId.set(this.ownId ?? '');
        w.connGuest.set_visible(guest);
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
        this._showConnecting({event: 'progress', step: 'device', state: 'start'}, true);
        const generation = this.hostGeneration;
        this.joinRun = this.bridge.start('join', {stdin: line, onEvent: ev => {
            if (generation !== this.hostGeneration || this.closed)
                return;
            if (ev.event === 'progress')
                this._showConnecting(ev, true);
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
        const finish = () => { if (!this.closed) (this.mode === 'add' ? this._enterAdd() : this._enterIds()); };
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

    // ---- the group page: banners, stopping, removing ----------------------------------------------------------------------

    // A confirmation: nothing runs before the user answers; Cancel is the default.
    _confirm({heading, body, confirmLabel, destructive = false, onConfirm}) {
        const dialog = new Adw.MessageDialog({transient_for: this.win, modal: true, heading, body});
        dialog.add_response('cancel', S.syncCancel());
        dialog.add_response('go', confirmLabel);
        if (destructive)
            dialog.set_response_appearance('go', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'go')
                onConfirm();
        });
        this.confirmDialog = dialog;
        dialog.present();
    }

    _confirmStop() {
        this._confirm({heading: S.syncStopAll(), body: S.syncStopConfirmBody(), confirmLabel: S.syncStopShort(), destructive: true, onConfirm: () => this._forget()});
    }

    // "Stop syncing" is `forget --all`: every other computer goes, this one stays set up.
    async _forget() {
        this._show('checking');
        const out = await this.bridge.run('forget', {flags: {all: true}});
        if (this.closed)
            return;
        if (!out.ok) {
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this.promoteDismissed = false;
        this.refresh();
    }

    // The one-time consent of 0.2.6 for the computers accepted before: `promote` for exactly the rows the banner is about.
    async _promote() {
        const ids = this.view?.promoteIds ?? [];
        if (ids.length === 0)
            return;
        await this._runThenRefresh('promote', {ids});
    }

    _promoteLater() {
        this.promoteDismissed = true;
        this.w.bnPromote.box.set_visible(false);
    }

    // "They are all mine": `ack` for the rows the banner counted, nothing else.
    async _ackNew() {
        const ids = this.view?.newIds ?? [];
        if (ids.length === 0)
            return;
        await this._runThenRefresh('ack', {ids});
    }

    async _runThenRefresh(verb, opts) {
        this._show('checking');
        const out = await this.bridge.run(verb, opts);
        if (this.closed)
            return;
        if (!out.ok) {
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this.refresh();
    }

    _confirmFinish() {
        this._confirm({heading: S.syncFinishShort(), body: S.syncRevokeNext(), confirmLabel: S.syncFinishShort(), onConfirm: () => this._finish()});
    }

    // `finish` refuses with E_REVOCATION_OPEN while a removed computer is back: that is not an error page, the group page shows the
    // "removed computer is back" row and the freeze banner again.
    async _finish() {
        this._show('checking');
        const out = await this.bridge.run('finish', {});
        if (this.closed)
            return;
        if (!out.ok && out.error.code !== 'E_REVOCATION_OPEN') {
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this.refresh();
    }

    // The remove page for one row of the status on screen. Lost or stolen is the default; the "I still have it" path exists only when the
    // policy switch and the row allow it (sync-flow.js).
    _openRemove(id) {
        const w = this.w;
        const status = this.status;
        const paths = removePaths(status, id, this.shortcutRemove);
        const row = (status?.peers ?? []).find(p => p.id === id);
        if (paths.length === 0 || row === undefined)
            return;
        this.rm = {id, path: 'lost', marked: removeDefaults(status, id)};
        w.removeTarget.set_label(`${row.name ?? S.syncNameUnreadable()}  ${compareLine(id)}`);
        w.removeHave.set_visible(paths.includes('have'));
        w.removeHaveDetail.set_visible(paths.includes('have'));
        w.removeLost.set_active(true);
        for (let c = w.removeList.get_first_child(); c !== null; c = w.removeList.get_first_child())
            w.removeList.remove(c);
        this.removeChecks = [];
        for (const p of status.peers) {
            if (p.id === id)
                continue;
            const check = new Gtk.CheckButton();
            check.set_child(this._text(`${p.name ?? S.syncNameUnreadable()}  ${compareLine(p.id)}`));
            check.set_active(this.rm.marked.has(p.id));
            check.connect('toggled', () => {
                if (check.get_active())
                    this.rm.marked.add(p.id);
                else
                    this.rm.marked.delete(p.id);
                this._updateRemove();
            });
            w.removeList.append(check);
            this.removeChecks.push({id: p.id, check});
        }
        this._updateRemove();
        this._show('remove');
    }

    _onRemovePath() {
        if (this.rm === null)
            return;
        this.rm.path = this.w.removeHave.get_active() ? 'have' : 'lost';
        this._updateRemove();
    }

    // What the page shows for the chosen path: the checklist only on the lost path, and no confirm for a choice the engine would refuse.
    _updateRemove() {
        const w = this.w;
        const rm = this.rm;
        const lost = rm.path === 'lost';
        w.removeLostDetail.set_visible(lost);
        w.removeOthers.set_visible(lost && this.removeChecks.length > 0);
        const pick = revokeIds(this.status, rm.id, rm.marked);
        w.removeTooMany.set_visible(lost && pick.tooMany);
        if (pick.tooMany)
            w.removeTooMany.set_label(S.syncRemoveTooMany(pick.max));
        w.removeConfirm.set_sensitive(lost ? !pick.tooMany && pick.ids.length > 0 : forgetId(this.status, rm.id, this.shortcutRemove) !== null);
    }

    _confirmRemove() {
        const rm = this.rm;
        if (rm === null)
            return;
        const label = id => {
            const p = this.status.peers.find(x => x.id === id);
            return `${p?.name ?? S.syncNameUnreadable()}  ${compareLine(id)}`;
        };
        if (rm.path === 'have') {
            const id = forgetId(this.status, rm.id, this.shortcutRemove);
            if (id === null)
                return;
            this._confirm({heading: S.syncRemoveTitle(), body: `${S.syncRemoveHaveDetail()}\n\n${label(id)}`, confirmLabel: S.syncRemoveButton(), destructive: true,
                onConfirm: () => this._runThenRefresh('forget', {ids: [id]})});
            return;
        }
        const pick = revokeIds(this.status, rm.id, rm.marked);
        if (pick.ids.length === 0)
            return;
        this._confirm({heading: S.syncRemoveTitle(), body: `${S.syncRemoveLostDetail()}\n\n${pick.ids.map(label).join('\n')}`, confirmLabel: S.syncRemoveButton(), destructive: true,
            onConfirm: () => this._runRevoke(pick.ids)});
    }

    // `revoke` for exactly the IDs chosen from the status on screen. The steps are shown as they come; there is no cancel.
    async _runRevoke(ids) {
        const w = this.w;
        this.revokeStatus = this.status;
        for (const s of Object.values(w.revokeSteps)) {
            s.spinner.set_spinning(false);
            s.spinner.set_visible(false);
            s.done.set_visible(false);
        }
        this._show('revoking');
        const run = this.bridge.start('revoke', {ids, onEvent: ev => {
            const s = ev.event === 'progress' ? w.revokeSteps[ev.step] : undefined;
            if (s === undefined || this.closed)
                return;
            const started = ev.state === 'start';
            s.spinner.set_visible(started);
            s.spinner.set_spinning(started);
            s.done.set_visible(!started);
        }});
        const out = await run.done;
        if (this.closed)
            return;
        if (!out.ok) {
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this._showRevokeResult(out.result);
    }

    _showRevokeResult(result) {
        const w = this.w;
        const sum = revokeSummary(this.revokeStatus, result);
        const list = items => items.map(i => `${i.name ?? S.syncNameUnreadable()} (${compareLine(i.id)})`).join(', ');
        w.resRemoved.set_label(S.syncRevokeRemoved(list(sum.removed)));
        w.resOffline.set_label(sum.offline.length > 0 ? S.syncRevokeOffline(list(sum.offline)) : '');
        w.resOffline.set_visible(sum.offline.length > 0);
        for (let c = w.resReturned.get_first_child(); c !== null; c = w.resReturned.get_first_child())
            w.resReturned.remove(c);
        this.resReturnedRows = [];
        for (const r of sum.returned) {
            const label = this._text(S.syncReturned(compareLine(r.id)));
            const button = this._button(S.syncRemoveButton(), () => this._removeAgain(r.id));
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
            box.append(label);
            box.append(button);
            w.resReturned.append(box);
            this.resReturnedRows.push({id: r.id, label, button});
        }
        this._show('revoke-result');
    }

    // A removed computer came back during the removal: read the list again (the old one still holds the rows that were just removed), then
    // the remove page for it.
    async _removeAgain(id) {
        const out = await this.bridge.run('status');
        if (this.closed)
            return;
        if (!out.ok) {
            this._showError(out.error.code, () => this.refresh());
            return;
        }
        this.status = out.result;
        if (pageForStatus(out.result) !== 'group' || !out.result.peers.some(p => p.id === id)) {
            this._showForStatus(out.result);
            return;
        }
        this._fillGroup(out.result);
        this._openRemove(id);
    }

    // ---- errors ---------------------------------------------------------------------------------------------------------

    // `retry`: what "Try again" does. An information code is a neutral page: no red, no "Try again".
    _showError(code, retry) {
        const view = errorView(code);
        const w = this.w;
        this.retry = retry;
        this.errAction = view.action;
        w.errTitle.set_label(view.neutral ? S.syncTitle() : S.syncErrorTitle());
        w.errText.set_label(S.syncErrorText(view.code, this.status?.max_computers ?? null));
        for (const cls of ['error', 'cetli-error'])
            w.errText.remove_css_class(cls);
        if (!view.neutral)
            w.errText.add_css_class('cetli-error');
        const label = {retry: S.syncTryAgain(), check: S.syncCheckAgain(), stop: S.syncStopShort()}[view.action];
        w.errAction.set_visible(label !== undefined);
        if (label !== undefined)
            w.errAction.set_label(label);
        this._show('error');
    }

    _onErrorAction() {
        if (this.errAction === 'stop')
            this._confirmStop();
        else if (this.errAction === 'check')
            this.refresh();
        else if (typeof this.retry === 'function')
            this.retry();
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
