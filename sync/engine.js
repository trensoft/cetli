// SPDX-License-Identifier: GPL-3.0-or-later
// The engine of the sync window (PLAN-WIZARD 0H, 0F, 7.2; PLAN-WIZARD-INTERFACE 2a, 3; 0.2.6: PLAN-0.2.6, PLAN-ADMISSION-0.2.6): the verbs status,
// setup, own-id, host, join, forget, revoke, finish, harden, promote and ack, for a group of up to MAX_COMPUTERS computers, and restart and reset
// (0.2.5.2: the ways out when the sync program does not answer) and ensure (0.2.7: the quiet start-up check).
// No Gio, no process, no file API of its own: everything is injected (`ports`), so a stub Syncthing and a stub file system run it in node.
// What it never does: read or write the notes, read a foreign config, call the REST interface or touch an API key (it uses `syncthing cli` only),
// remove a device nobody named (it removes only IDs in the list it just read, named by the window), remove the folder or a file, or put anything
// of a peer on a command line or in a log (the one exception is the sanitised label of an accepted computer, as ONE `--name=` argument).
// The one other exception is `reset` (0.2.5.2): it moves the instance directory aside (never deletes it) and takes away the marker of OUR folder.
//
// ports = {
//   run:      createRunPort(...)        syncthing(sub, args, opts) -> {rc, out, tooLarge?}, systemctl(args, opts)
//   files:    {exists(p), readText(p), writeText(p, text, mode), mkdirp(p, mode), modeOf(p), isDir(p), isSymlink(p), listNames(p),
//              rename(from, to), removeFile(p), removeDir(p)}     the last three are used by `reset` ONLY (the instance directory and the marker)
//   dirs:     {homeDir, notes, home}    the user's home, the core's notes directory, the dedicated instance's home
//   now(), monotonic(), sleep(ms)       wall clock ms, monotonic ms, a timer
//   input:    {lines() -> string[], eof() -> bool}       host only: what the window wrote on stdin
//   emit(event), log(text)              events of the protocol (without v), a journal line (codes and field names only)
//   timing?:  overrides of the constants below (tests)
// }
import {NAME_MAIN} from '../src/constants.js';
import {ConfigEditError, PORTS_OWN, editConfig, readFolders, verifyConfig} from './confedit.js';
import {canonicalId, displayName, isCanonicalId, parseTypedId} from './ids.js';
import {MARKER_NAME, markerPaths} from './markers.js';
import {BACKEND_EXE, FOLDER_ID, MARKER_HINT_FILE, UNIT_NAME, dedicatedHome, socketPath} from './paths.js';
import {DWELL_MS, HARDEN_INTRODUCED, MAX_COMPUTERS, MAX_PEERS, READ_CAP, REMOVED_MAX, SHORTCUT_REMOVE, wantedIntroducer} from './policy.js';
import {parseAcceptLine} from './protocol.js';
import {
    FREEZE_MAX, STATE_FILE, brokenState, freshState, isFrozen, parseState, serializeState, withAck, withFreeze, withTomb, withoutFreeze, withoutTomb,
} from './state.js';

export const TIMING = Object.freeze({
    linkSamples: 10,                       // LINK_SAMPLES: consecutive connected samples that make the link stable (Interface 3)
    linkGapMs: 1000,                       // LINK_GAP_MS: the pause between two samples; a longer gap than twice this ends the run
    peerTimeoutMs: 5 * 60 * 1000,          // E_PEER_TIMEOUT
    hostWindowMs: 15 * 60 * 1000,          // E_EXPIRED
    pendingPollMs: 2000,
    tickMs: 100,
    serviceWaitMs: 30000,
    servicePollMs: 500,
    statusWaitMs: 5000,
    dwellMs: DWELL_MS,                     // revoke: the wait between the first and the second read-back
    ensureWaitMs: 3000,                    // ensure: how long the daemon gets to answer before the unit is looked at (the start-up check is quiet and short)
    systemctlMs: 120000,                   // restart and disable --now wait for the stop of the unit (systemd's own limit is 90 s)
});
export const PENDING_MAX_BYTES = 16 * 1024 * 1024;
export {MAX_PEERS};                        // the number lives in policy.js (10 computers = 9 peers)
export const PEER_LABEL = 'other computer';

class Fail extends Error {
    constructor(code, step = null) {
        super(code);
        this.code = code;
        this.step = step;
    }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ONE predicate for setup, host, join, the accept step, status and the removal verbs (Interface 2a, invariants I1-I4 of PLAN-ADMISSION-0.2.6 1.3):
// a device is foreign when the own device is an introducer or auto-accepts folders, or another device auto-accepts folders, keeps
// removals back (skipIntroductionRemovals), or names an `introducedBy` that is no canonical ID, the own ID or itself. `introducer` is free
// for the other devices: the daemon copies the flag of the introducer. The count is NOT part of it (overLimit). The engine never removes
// such an entry itself.
export function foreignDevices(devices, ownId) {
    return devices.filter(d => d.id === ownId ?
        d.introducer || d.autoAcceptFolders :
        d.autoAcceptFolders || d.skipIntroductionRemovals || (d.introducedBy !== '' && (!isCanonicalId(d.introducedBy) || d.introducedBy === ownId || d.introducedBy === d.id)));
}

// I7: more than MAX_PEERS other devices. Detective only: the daemon, not our code, admits an introduced device.
export const overLimit = (devices, ownId) => devices.filter(d => d.id !== ownId).length > MAX_PEERS;

// The folder set of the dedicated instance must be exactly {cetli-notes}: absolute path equal to the notes path, send-receive, and every
// folder-device record an ID (own or a listed device, when the devices are given) with an `introducedBy` that is empty or canonical (I6;
// an introduced computer is in the folder with the introducer's name in that field). Returns true when something is wrong.
export function folderAnomaly(folders, notesPath, devices = null) {
    if (folders.length !== 1 || folders[0].id !== FOLDER_ID)
        return true;
    const f = folders[0];
    if (f.path !== notesPath || !f.path.startsWith('/') || f.type !== 'sendreceive')
        return true;
    const known = devices === null ? null : new Set(devices.map(d => d.id));
    return f.devices.some(d => !isCanonicalId(d.id) || (d.introducedBy !== '' && !isCanonicalId(d.introducedBy)) || (known !== null && !known.has(d.id)));
}

export function createEngine(ports) {
    const {run, files, dirs, emit, log} = ports;
    const t = {...TIMING, ...(ports.timing ?? {})};
    // the two switches of policy.js; the tests run both values (PLAN-0.2.6 2.1)
    const policy = {hardenIntroduced: HARDEN_INTRODUCED, shortcutRemove: SHORTCUT_REMOVE, ...(ports.policy ?? {})};
    const configPath = `${dirs.home}/config.xml`;
    const sock = socketPath(dirs.home);
    const editArgs = {socketPath: sock, ports: PORTS_OWN};

    // ---- small helpers --------------------------------------------------------------------------------------------------

    const progress = (step, state) => emit({event: 'progress', step, state});
    async function step(name, fn) {
        progress(name, 'start');
        try {
            const v = await fn();
            progress(name, 'ok');
            return v;
        } catch (e) {
            if (e instanceof Fail && e.step === null)
                e.step = name;
            throw e;
        }
    }

    async function cli(args, opts) {
        const r = await run.syncthing('cli', args, opts);
        if (r.tooLarge || r.rc !== 0)
            throw new Fail('E_CLI_FAILED');                                  // E_PENDING_TOO_LARGE is host's alone (the pending list, read in host())
        return r.out;
    }

    const lines = out => out.split('\n').map(s => s.trim()).filter(s => s !== '');
    function json(out) {
        try {
            return JSON.parse(out);
        } catch {
            throw new Fail('E_CLI_FAILED');
        }
    }

    async function ownId() {
        const r = await run.syncthing('device-id');
        if (r.rc !== 0)
            throw new Fail('E_CLI_FAILED');
        const id = canonicalId(r.out.trim());
        if (id === null)
            throw new Fail('E_INTERNAL');
        return id;
    }

    const backendInstalled = () => files.exists(BACKEND_EXE);
    const markerHit = () => markerPaths(dirs.notes, dirs.homeDir).some(p => files.exists(p));

    // Is the folder ours? Read from OUR OWN config.xml (never a foreign one); no file, an unreadable or odd file: not ours.
    function holdsFolder() {
        if (!files.exists(configPath))
            return false;
        try {
            return readFolders(files.readText(configPath)).some(f => f.id === FOLDER_ID);
        } catch {
            return false;
        }
    }

    // The names inside a marker directory when it is no link, its notes directory is no link, and it holds nothing or only plain hint files; else null.
    // Asked again right before the marker is taken away (the leaving of the unit can take long, and a path can be swapped meanwhile).
    function plainMarkerNames(path) {
        try {
            if (files.isSymlink(dirs.notes) || !files.exists(path) || files.isSymlink(path) || !files.isDir(path))
                return null;
            const names = files.listNames(path);
            return names.every(n => MARKER_HINT_FILE.test(n) && !files.isSymlink(`${path}/${n}`) && !files.isDir(`${path}/${n}`)) ? names : null;
        } catch {
            return null;
        }
    }

    // The marker of OUR folder in the notes directory, or null. Ours means: our own config.xml holds `cetli-notes` with exactly the notes path,
    // the notes path and the marker are no links, and the marker is a directory that holds nothing or only Syncthing's hint file(s) as plain files.
    // Anything else (a foreign marker, a link, a file of unknown name) is null and stays where it is. Read BEFORE the instance is moved.
    function ownMarker() {
        const path = `${dirs.notes}/${MARKER_NAME}`;
        try {
            const folder = readFolders(files.readText(configPath)).find(f => f.id === FOLDER_ID);
            if (!folder || folder.path !== dirs.notes || files.isSymlink(dirs.notes))
                return null;
            const names = plainMarkerNames(path);
            return names === null ? null : {path, names};
        } catch {
            return null;
        }
    }

    async function daemonAnswers(waitMs) {
        const t0 = ports.monotonic();
        for (;;) {
            const r = await run.syncthing('cli', ['show', 'system']);
            if (r.rc === 0)
                return true;
            if (ports.monotonic() - t0 >= waitMs)
                return false;
            await ports.sleep(t.servicePollMs);
        }
    }

    // The read-back of the instance: every device with its flags, every folder with its path, type and devices (M-W1 commands). A list of more
    // than READ_CAP devices is not read one by one (a hostile introducer can list any number): `overCap` is true, `devices` is empty and
    // `ids` still holds the listed IDs. `computers` is the number of devices listed (own included).
    async function readConfig() {
        const ids = lines(await cli(['config', 'devices', 'list']));
        if (!ids.every(isCanonicalId))
            throw new Fail('E_CLI_FAILED');
        const devices = [];
        // The daemon neither filters nor limits what an introducer sends (M-I5, M-I6): at most READ_CAP `dump-json` calls, and the name is
        // reduced to the displayName gate the moment it is read (a 100 000 character name is never kept).
        if (ids.length <= READ_CAP) {
            for (const id of ids) {
                const d = json(await cli(['config', 'devices', id, 'dump-json']));
                if (!isObj(d) || d.deviceID !== id)
                    throw new Fail('E_CLI_FAILED');
                devices.push({
                    id, name: displayName(d.name) ?? '', introducer: d.introducer === true, autoAcceptFolders: d.autoAcceptFolders === true,
                    skipIntroductionRemovals: d.skipIntroductionRemovals === true, introducedBy: typeof d.introducedBy === 'string' ? d.introducedBy : 'invalid',
                });
            }
        }
        const folders = [];
        for (const id of lines(await cli(['config', 'folders', 'list']))) {
            const f = json(await cli(['config', 'folders', id, 'dump-json']));
            if (!isObj(f) || f.id !== id || !Array.isArray(f.devices))
                throw new Fail('E_CLI_FAILED');
            folders.push({
                id, path: typeof f.path === 'string' ? f.path : '', type: f.type,
                devices: f.devices.map(x => ({id: x?.deviceID, introducedBy: typeof x?.introducedBy === 'string' ? x.introducedBy : 'invalid'})),
            });
        }
        return {devices, folders, ids, overCap: ids.length > READ_CAP, computers: ids.length};
    }

    function countNotes() {
        try {
            return files.listNames(dirs.notes).filter(n => NAME_MAIN.test(n)).length;
        } catch {
            return null;
        }
    }

    // The peers of the instance (every device but the own one) and whether the folder is shared with one of them.
    function peersOf(cfg, own) {
        const peers = cfg.devices.filter(d => d.id !== own);
        const folder = cfg.folders.find(f => f.id === FOLDER_ID);
        return {peers, shared: peer => folder?.devices.some(d => d.id === peer.id) ?? false};
    }

    // ---- the state file (sync/state.js): acknowledged computers, tombstones, the open freeze --------------------------------------

    const statePath = `${dirs.home}/${STATE_FILE}`;
    // {state, missing}. A file that is a link or does not read cleanly is NOT a fresh state: it is an open freeze with nothing known (fail
    // closed; `finish` repairs it).
    function loadState() {
        if (!files.exists(statePath))
            return {state: freshState(), missing: true};
        try {
            if (files.isSymlink(statePath))
                return {state: brokenState(), missing: false};
            const r = parseState(files.readText(statePath));
            return r.ok ? {state: r.state, missing: false} : {state: brokenState(), missing: false};
        } catch {
            return {state: brokenState(), missing: false};
        }
    }
    // The first write seeds the directly accepted devices into `ack`: 0.2.5 allowed no other kind, so each was accepted by a click or a typed ID.
    function saveState(state, cfg, own) {
        const {missing} = loadState();
        let next = state;
        if (next.broken && cfg)                                              // the file was unreadable: it stays a freeze over EVERY peer when rewritten
            next = withFreeze({...next, freeze: {ids: []}}, cfg.ids.filter(id => id !== own).slice(0, FREEZE_MAX));
        if (missing && cfg) {
            const direct = cfg.devices.filter(d => d.id !== own && d.introducedBy === '').map(d => d.id);
            next = withAck(next, direct.filter(id => !next.ack.includes(id) && !next.tomb.includes(id)));
        }
        files.writeText(statePath, serializeState(next), 0o600);
        return next;
    }
    const isAcked = (ls, d) => ls.state.ack.includes(d.id) || (ls.missing && d.introducedBy === '');
    // Tombstoned IDs that are in the device list again.
    const returnedIds = (ls, cfg) => cfg.devices.filter(d => ls.state.tomb.includes(d.id)).map(d => d.id);

    // ---- the link (Interface 3, `link` and the "Connected" claim) -------------------------------------------------------

    // One `show connections` call: the `connections` object, or null when the call failed (a broken sample, not the end of a run).
    async function readConnections() {
        try {
            const o = json(await cli(['show', 'connections']));
            return isObj(o?.connections) ? o.connections : {};
        } catch (e) {
            if (!(e instanceof Fail))
                throw e;
            return null;
        }
    }
    const connectedIn = (connections, peerId) => connections !== null && isObj(connections[peerId]) && connections[peerId].connected === true;

    // A tracker for ONE peer. Raw `connected` is never proof (M-W6): `stable` is `linkSamples` CONSECUTIVE connected samples taken
    // `linkGapMs` apart on the monotonic clock (Interface 3, option (a) of 0G.2; there is no `cli` completion, so nothing says "synced").
    // A failed or timed-out call, a not-connected sample, or a gap of more than twice `linkGapMs` between two samples restarts the count.
    // `connectedS` is the length of the unbroken run this engine saw, first to last sample, in whole seconds; null unless stable.
    // `observe(connected)` takes the answer of a call somebody else made (status reads ONE `show connections` for all peers); `sample()`
    // makes the call itself (host and join watch one peer).
    // A sample also says `failed` (the call itself failed or timed out): for the count that is a broken sample, but `status` must not turn it into
    // "not connected" (0.2.6: the call said nothing about the link).
    function createLinkTracker(peerId) {
        let consecutive = 0;
        let runStart = null;
        let lastAt = null;
        let everConnected = false;
        const v = {link: 'none', connectedS: null, connected: false};
        const tracker = {
            get value() { return {...v}; },
            observe(connected, failed = false) {
                const at = ports.monotonic();
                if (lastAt !== null && at - lastAt > 2 * t.linkGapMs)
                    consecutive = 0;
                lastAt = at;
                v.connected = connected;
                if (!connected) {
                    consecutive = 0;
                    v.link = everConnected ? 'flapping' : 'none';
                    v.connectedS = null;
                    return {...v, failed};
                }
                everConnected = true;
                if (consecutive === 0)
                    runStart = at;
                consecutive++;
                // the count AND the time: ten samples that were taken closer than the gap prove less than ten seconds
                const spanMs = at - runStart;
                const stable = consecutive >= t.linkSamples && spanMs >= (t.linkSamples - 1) * t.linkGapMs;
                v.link = stable ? 'stable' : 'flapping';
                v.connectedS = stable ? Math.floor(spanMs / 1000) : null;
                return {...v, failed};
            },
            async sample() {
                return tracker.observe(connectedIn(await readConnections(), peerId));
            },
        };
        return tracker;
    }

    // The state of the listeners for `status` (Interface 2a): `cli show system`, key connectionServiceStatus (address -> {error, ...} or
    // [error, ...]). Only the tcp:// and quic:// entries count; the relay entry carries an error whenever the network is unreachable, which is
    // not a listener fault. An unreadable or unexpected shape is null (never an error), and so is a list without a tcp/quic entry or an
    // entry without its error field: nothing is claimed `ok` that was not seen. Measured on the real syncthing 2.1.6 binary (John, 8621):
    // an OBJECT address -> {error, lanAddresses, wanAddresses}, `error` null when healthy, a string for a busy port, on tcp:// and quic://.
    // The array shape is kept as a tolerance; the real binary does not give it. Not measured: dynamic+https:// relay entries, tcp4/tcp6/quic4
    // entries, the `default` listenAddress. `down`: the call itself does not get an answer.
    async function listenerState() {
        const r = await run.syncthing('cli', ['show', 'system']);
        if (r.rc !== 0 && !r.tooLarge)
            return 'down';
        let o;
        try {
            o = JSON.parse(r.out);
        } catch {
            return null;
        }
        const entries = o?.connectionServiceStatus;
        if (!isObj(entries))
            return null;
        let seen = 0;
        let degraded = false;
        for (const [address, v] of Object.entries(entries)) {
            if (!/^(tcp|quic)[46]?:\/\//.test(address))
                continue;
            if (!Array.isArray(v) && !isObj(v))
                return null;
            // `ok` needs the error field to be there: {} or [] says nothing about the listener (the real syncthing 2.1.6 always has
            // the key, `null` when the listener is fine)
            if (Array.isArray(v) ? v.length < 1 : !Object.hasOwn(v, 'error'))
                return null;
            const error = Array.isArray(v) ? v[0] : v.error;
            if (error !== null && typeof error !== 'string')
                return null;
            seen++;
            if (typeof error === 'string' && error !== '')
                degraded = true;
        }
        return seen === 0 ? null : degraded ? 'degraded' : 'ok';
    }

    // status: ONE `show connections` call per second feeds one tracker per peer. A peer's run ends at its first not-connected sample or when it
    // is stable; the run ends when every peer is done, so a computer that is off costs one sample and the success path pays the K samples
    // once for all peers together (as in 0.2.5 for one). A call that failed ends the run of every peer still active, but as "unknown" (link null,
    // connected null): the window shows "Checking the connection" and asks again, it never claims "not connected" (0.2.6). Returns the values in
    // the order of `peerIds`.
    async function measureLinks(peerIds) {
        const trackers = peerIds.map(id => createLinkTracker(id));
        const unknown = new Set();
        let queryLogged = false;
        let active = trackers.map((_, i) => i);
        for (let i = 0; i < t.linkSamples + 1 && active.length > 0; i++) {
            const connections = await readConnections();
            if (connections === null && !queryLogged) {
                queryLogged = true;
                log('link: the connection query failed');
            }
            active = active.filter(k => {
                const s = trackers[k].observe(connectedIn(connections, peerIds[k]), connections === null);
                if (s.failed) {
                    unknown.add(k);
                    return false;
                }
                return s.connected && s.link !== 'stable';
            });
            if (active.length > 0 && i < t.linkSamples)
                await ports.sleep(t.linkGapMs);
        }
        return trackers.map((tr, k) => unknown.has(k) ? {link: null, connected: null, connectedS: null} : tr.value);
    }

    // host and join: sample until stable. Events on every change of the state, at most one per sample (one per second).
    async function awaitStable(peerId, {stop = () => false} = {}) {
        const tracker = createLinkTracker(peerId);
        const t0 = ports.monotonic();
        let last = null;
        progress('connect', 'start');
        for (;;) {
            if (stop())
                throw new Fail('E_EXPIRED', 'connect');
            const s = await tracker.sample();
            if (last === null || s.link !== last.link)
                emit({event: 'link', state: s.link, connected_s: s.connectedS});
            last = s;
            if (s.link === 'stable') {
                progress('connect', 'ok');
                return s;
            }
            if (ports.monotonic() - t0 >= t.peerTimeoutMs)
                throw new Fail('E_PEER_TIMEOUT', 'connect');
            await ports.sleep(t.linkGapMs);
        }
    }

    // ---- the instance --------------------------------------------------------------------------------------------------

    function prepareInstance() {
        if (!files.exists(dirs.home))
            files.mkdirp(dirs.home, 0o700);
        if (files.modeOf(dirs.home) !== 0o700 || files.isSymlink(dirs.home))
            throw new Fail('E_CONFIG_UNSAFE');                              // S-4: the home is 0700 and not a link, or nothing is done
    }

    function editOwnConfig() {
        let xml;
        try {
            xml = files.readText(configPath);
            const r = editConfig(xml, editArgs);
            if (r.changed)
                files.writeText(configPath, r.xml, 0o600);
            const problems = verifyConfig(r.xml, editArgs);
            if (problems.length > 0)
                throw new ConfigEditError(problems[0].reason, problems[0].field, problems[0].line);
        } catch (e) {
            if (e instanceof ConfigEditError) {
                log(`config: ${e.reason} (${e.field}${e.line ? `, line ${e.line}` : ''})`);
                throw new Fail('E_CONFIG_UNSAFE');
            }
            throw e;
        }
        if (files.modeOf(configPath) !== 0o600)
            throw new Fail('E_CONFIG_UNSAFE');
    }

    // Before every start, also when nothing is installed anew (H2): the file still says what we edited.
    function recheckConfig() {
        const problems = verifyConfig(files.readText(configPath), editArgs);
        if (problems.length > 0) {
            log(`config: ${problems[0].reason} (${problems[0].field}${problems[0].line ? `, line ${problems[0].line}` : ''})`);
            throw new Fail('E_CONFIG_UNSAFE');
        }
    }

    // ---- verbs ---------------------------------------------------------------------------------------------------------

    // How the peers of the instance appear in `status` (PLAN-0.2.6 3.2). The name is a hint only (displayName); `introduced_by` is the
    // introducer's ID when it is a canonical one.
    function peerEntry(d, cfg, own, ls, links) {
        const {shared} = peersOf(cfg, own);
        return {
            id: d.id, name: displayName(d.name), introduced_by: d.introducedBy !== '' && isCanonicalId(d.introducedBy) ? d.introducedBy : null,
            introducer: d.introducer, shared: shared(d), connected: links?.connected ?? null, link: links?.link ?? null, connected_s: links?.connectedS ?? null,
            new: !isAcked(ls, d), returned: ls.state.tomb.includes(d.id),
        };
    }

    async function status() {
        const base = {
            event: 'result', state: 'not-set-up', own_id: null, peers: [], computers: null, max_computers: MAX_COMPUTERS, over_limit: false, revocation_open: false,
            harden_pending: 0, promote_pending: 0, removed: [], listener: null, up_to_date: null, notes: null, waiting: false,
        };
        if (!backendInstalled())
            return {result: {...base, state: 'no-syncthing'}};
        const ours = holdsFolder();
        if (markerHit() && !ours)
            return {result: {...base, state: 'stfolder-conflict'}};
        if (!files.exists(configPath))
            return {result: base};
        const own = await ownId();
        const up = await daemonAnswers(t.statusWaitMs);
        if (!up) {
            if (!ours)
                return {result: {...base, own_id: own}};
            throw new Fail('E_SERVICE_TIMEOUT');
        }
        const cfg = await readConfig();
        if (!cfg.folders.some(f => f.id === FOLDER_ID))
            return {result: {...base, own_id: own}};
        const ls = loadState();
        const open = isFrozen(ls.state);
        const removed = ls.state.tomb.filter(id => !cfg.ids.includes(id)).slice(-REMOVED_MAX).reverse();
        const known = {...base, own_id: own, computers: cfg.computers, revocation_open: open, removed};
        if (cfg.overCap)                                          // the list is not read: no peers, nothing is known about the share
            return {result: {...known, state: 'half', over_limit: true}};
        const foreign = foreignDevices(cfg.devices, own).length > 0 || folderAnomaly(cfg.folders, dirs.notes, cfg.devices);
        const {peers, shared} = peersOf(cfg, own);
        const over = peers.length > MAX_PEERS;
        const shown = peers.slice(0, MAX_COMPUTERS);
        if (foreign)
            return {result: {...known, state: 'foreign-config', over_limit: over, peers: shown.map(d => peerEntry(d, cfg, own, ls, null))}};
        const harden = peers.filter(d => d.introducedBy !== '' && d.introducer && !wantedIntroducer(d, policy.hardenIntroduced)).length;
        const promote = open ? 0 : peers.filter(d => d.introducedBy === '' && !d.introducer).length;
        const listener = await listenerState();
        const counters = {over_limit: over, harden_pending: harden, promote_pending: promote, listener, notes: countNotes()};
        if (peers.length === 0)
            return {result: {...known, ...counters, state: 'set-up'}};
        const state = peers.some(shared) ? 'paired' : 'half';
        const links = over ? [] : await measureLinks(peers.map(d => d.id));
        return {result: {...known, ...counters, state, peers: shown.map((d, i) => peerEntry(d, cfg, own, ls, links[i]))}};
    }

    async function setup() {
        if (!backendInstalled())
            throw new Fail('E_NO_SYNCTHING');
        if (markerHit() && !holdsFolder())
            throw new Fail('E_STFOLDER_EXISTS');                           // nothing written, nothing started
        await step('instance', async () => {
            prepareInstance();
            if (!files.exists(configPath)) {
                const g = await run.syncthing('generate');
                if (g.rc !== 0)
                    throw new Fail('E_CLI_FAILED');
            }
            editOwnConfig();                                                // generate -> our edit -> read-back -> only then serve
        });
        await step('service', async () => {
            recheckConfig();
            const on = await run.systemctl(['--user', 'enable', '--now', UNIT_NAME]);
            if (on.rc !== 0)
                throw new Fail('E_NO_USER_SYSTEMD');
            if (!(await daemonAnswers(t.serviceWaitMs)))
                throw new Fail('E_SERVICE_TIMEOUT');
        });
        const own = await ownId();
        await step('folder', async () => {
            if (files.isSymlink(dirs.notes) || !dirs.notes.startsWith('/'))
                throw new Fail('E_CONFIG_UNSAFE');
            const existing = lines(await cli(['config', 'folders', 'list']));
            if (!existing.includes(FOLDER_ID)) {
                // The engine supplies every value (M-W7b2): absolute notes path, send-receive, the cetli settings; never autoAcceptFolders.
                await cli(['config', 'folders', 'add', '--id', FOLDER_ID, '--label', 'cetli', '--path', dirs.notes, '--type', 'sendreceive',
                    '--fswatcher-enabled', '--fswatcher-delays', '1', '--ignore-perms', '--max-conflicts', '-1']);
            }
            const cfg = await readConfig();
            if (foreignDevices(cfg.devices, own).length > 0)
                throw new Fail('E_FOREIGN_DEVICE');
            if (folderAnomaly(cfg.folders, dirs.notes, cfg.overCap ? null : cfg.devices))
                throw new Fail('E_CONFIG_UNSAFE');
            refuseWhileClosed(cfg, own);
        });
        return {result: {event: 'result', own_id: own, state: 'set-up'}};
    }

    async function ownIdVerb() {
        if (!backendInstalled())
            throw new Fail('E_NO_SYNCTHING');
        return {result: {event: 'result', own_id: await ownId()}};
    }

    // ---- the group: what host, join and the removal verbs share ---------------------------------------------------------

    // The admission verbs (host, join, setup) are refused while a removal is open (I9: an open freeze, an unreadable state file, or a
    // tombstoned computer that is back in the list, I8) and, with `full`, while the group is over its limit (I7).
    function refuseWhileClosed(cfg, own, {full = true} = {}) {
        const ls = loadState();
        if (isFrozen(ls.state) || returnedIds(ls, cfg).length > 0)
            throw new Fail('E_REVOCATION_OPEN');
        if (full && (cfg.overCap || overLimit(cfg.devices, own)))
            throw new Fail('E_GROUP_FULL');
    }

    // The common start of the verbs that act on an existing instance and must ALSO run in foreign-config and over-limit, because they are
    // the way out of those states (forget, revoke, finish, harden, promote, ack): backend, instance, daemon, config. No invariant is enforced.
    async function prepareLight() {
        if (!backendInstalled())
            throw new Fail('E_NO_SYNCTHING');
        if (!files.exists(configPath))
            throw new Fail('E_CLI_FAILED');
        const own = await ownId();
        if (!(await daemonAnswers(t.statusWaitMs)))
            throw new Fail('E_SERVICE_TIMEOUT');
        return {own, cfg: await readConfig()};
    }

    // Every ID a verb names must be in the list this run just read (or, for a rerun of `revoke`, a tombstone of an earlier run: it is simply
    // skipped as absent), and not the own one: else E_BAD_ID and nothing is written.
    function namedIds(ids, cfg, own, tomb = []) {
        if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => id === own || !(cfg.ids.includes(id) || tomb.includes(id))))
            throw new Fail('E_BAD_ID');
        return ids;
    }

    const setIntroducer = (id, value) => cli(['config', 'devices', id, 'introducer', 'set', String(value)]);

    // The share first, then the device, for each ID in the order given; what is already absent is skipped (a rerun after a crash is safe).
    async function deleteIds(ids, cfg) {
        const folder = cfg.folders.find(f => f.id === FOLDER_ID);
        for (const id of ids) {
            if (folder?.devices.some(d => d.id === id))
                await cli(['config', 'folders', FOLDER_ID, 'devices', id, 'delete']);
            if (cfg.ids.includes(id))
                await cli(['config', 'devices', id, 'delete']);
        }
    }
    const absent = (cfg, ids) => !cfg.ids.some(id => ids.includes(id)) && !cfg.folders.some(f => f.devices.some(d => ids.includes(d.id)));

    // `forget --all [--stop]`: the "start over" and the old "Stop syncing". `forget <ID>`: the shortcut for a computer the user still has
    // (SHORTCUT_REMOVE, M-J1), only for a directly accepted device: a plain delete of an introduced one is not durable [M 215, 217].
    // Both remove devices and shares, never the folder, never a file, never the instance (D1).
    async function forget({all = false, stop = false, ids = []} = {}) {
        if (!backendInstalled())
            throw new Fail('E_NO_SYNCTHING');
        if (!all && !policy.shortcutRemove)
            throw new Fail('E_BAD_ID');
        if (all && !files.exists(configPath))
            return {result: {event: 'result', state: 'set-up', remaining: 0}};
        const {own, cfg} = await prepareLight();
        if (all) {
            const targets = cfg.ids.filter(id => id !== own);
            await step('device', async () => {
                // lower every flag first: a peer that stays flagged could hand a removed computer back
                const flagged = cfg.overCap ? targets : cfg.devices.filter(d => d.id !== own && d.introducer).map(d => d.id);
                for (const id of flagged)
                    await setIntroducer(id, false);
            });
            await step('share', async () => {
                await deleteIds(targets, cfg);
                const after = await readConfig();                           // read back: what IS
                if (!absent(after, targets))
                    throw new Fail('E_CLI_FAILED');
                if (!after.folders.some(f => f.id === FOLDER_ID))
                    throw new Fail('E_INTERNAL');
                files.writeText(statePath, serializeState(freshState()), 0o600);        // the acknowledgements, tombstones and the freeze go with the group
            });
            if (stop) {
                const off = await run.systemctl(['--user', 'disable', '--now', UNIT_NAME]);
                if (off.rc !== 0)
                    throw new Fail('E_NO_USER_SYSTEMD');
            }
            return {result: {event: 'result', state: 'set-up', remaining: 0}};
        }
        const [id] = namedIds(ids, cfg, own);
        if (ids.length !== 1 || cfg.devices.find(d => d.id === id)?.introducedBy !== '')
            throw new Fail('E_BAD_ID');
        const after = await step('share', async () => {
            const ls = loadState();
            saveState(withTomb({...ls.state, ack: ls.state.ack.filter(x => x !== id)}, [id]), cfg, own);       // first: it may come back from a computer that still lists it
            await deleteIds([id], cfg);
            const back = await readConfig();
            if (!absent(back, [id]))
                throw new Fail('E_CLI_FAILED');
            return back;
        });
        const remaining = after.ids.filter(x => x !== own).length;
        return {result: {event: 'result', state: remaining === 0 ? 'set-up' : null, remaining}};
    }

    // `revoke <X> [<ID>...]`: the computer is lost or stolen, or not known (PLAN-ADMISSION 2.4). The first ID is the one the user named; the
    // others are rows the user marked "not mine". Order: the state file FIRST (write-ahead: an open freeze and the tombstones), then every
    // peer's introducer flag off (X first), a read-back, only then the shares and devices (X last), a read-back, a dwell, a second
    // read-back and one `show connections` sample for the computers that were offline. A device that came back is a result, not an error.
    // Every step is idempotent: a run that was cut short is simply run again.
    async function revoke({ids = []} = {}) {
        const {own, cfg} = await prepareLight();
        namedIds(ids, cfg, own, loadState().state.tomb);
        const [x] = ids;
        // More peers than the freeze can record: a removal that froze only the first FREEZE_MAX would report a success that is not one. Refused
        // before anything is written; the way out is `forget --all` ("Stop syncing"). The order of the steps below is unchanged.
        if (cfg.ids.filter(id => id !== own).length > FREEZE_MAX)
            throw new Fail('E_GROUP_FULL', 'freeze');
        const freezeSet = [x, ...cfg.ids.filter(id => id !== own && id !== x)].filter(id => cfg.ids.includes(id));                     // X may be gone already (a rerun)
        await step('freeze', async () => {
            const ls = loadState();
            saveState(withFreeze(withTomb(ls.state, ids), freezeSet), cfg, own);
            for (const id of freezeSet)
                await setIntroducer(id, false);
            // read back: no frozen peer is an introducer (a list over the cap is not in `back.devices`: ask for the frozen ones one by one)
            const back = await readConfig();
            const flags = back.overCap ? await Promise.all(freezeSet.map(async id => json(await cli(['config', 'devices', id, 'dump-json'])).introducer === true)) : back.devices.filter(d => freezeSet.includes(d.id)).map(d => d.introducer);
            if (flags.some(Boolean))
                throw new Fail('E_CLI_FAILED');
        });
        await step('remove', async () => deleteIds([...ids.slice(1), x], cfg));
        await step('verify', async () => {
            if (!absent(await readConfig(), ids))
                throw new Fail('E_CLI_FAILED');
        });
        progress('dwell', 'start');
        await ports.sleep(t.dwellMs);                                       // one reconnect cycle: a returning lister re-adds within about a second [M 133, 219]
        const after = await readConfig();
        const connections = await readConnections();
        if (connections === null)
            throw new Fail('E_CLI_FAILED', 'dwell');
        progress('dwell', 'ok');
        const returned = ids.filter(id => after.ids.includes(id));
        const nameOf = id => displayName(after.devices.find(d => d.id === id)?.name);
        const offline = after.ids.filter(id => id !== own && !ids.includes(id) && !connectedIn(connections, id)).slice(0, MAX_COMPUTERS).map(id => ({id, name: nameOf(id)}));
        return {result: {
            event: 'result', removed: ids.filter(id => !returned.includes(id)), returned, offline, remaining: after.ids.filter(id => id !== own).length, revocation_open: true,
        }};
    }

    // `finish`: only on the user's click. The frozen peers get the flag the policy wants (a directly accepted one: on; an introduced one:
    // off while hardening), never "exactly what it was" (PLAN-0.2.6 F6); then the freeze ends. The tombstones stay. An unreadable state file
    // counts as a freeze over every peer. No timer anywhere.
    async function finish() {
        const {own, cfg} = await prepareLight();
        const ls = loadState();
        if (!isFrozen(ls.state))
            return {result: {event: 'result', revocation_open: false}};
        if (returnedIds(ls, cfg).length > 0)
            throw new Fail('E_REVOCATION_OPEN');                              // a removed computer is back: remove it again first (PLAN-ADMISSION 2.3, 10)
        await step('device', async () => {
            const frozen = ls.state.broken ? cfg.ids : ls.state.freeze.ids;
            const wanted = d => wantedIntroducer(d, policy.hardenIntroduced);
            const mine = devices => devices.filter(d => d.id !== own && frozen.includes(d.id));
            for (const d of mine(cfg.devices)) {
                if (d.introducer !== wanted(d))
                    await setIntroducer(d.id, wanted(d));
            }
            if (mine((await readConfig()).devices).some(d => d.introducer !== wanted(d)))
                throw new Fail('E_CLI_FAILED');
            saveState(withoutFreeze(ls.state), cfg, own);
        });
        return {result: {event: 'result', revocation_open: false}};
    }

    // `harden`: introduced devices lose the introducer flag the daemon copied (V-A2, HARDEN_INTRODUCED, M-J5). Only lowers; never deletes.
    // `status` stays read only, so the window calls this when `harden_pending` is not 0.
    async function harden() {
        if (!policy.hardenIntroduced)
            return {result: {event: 'result', changed: 0}};
        const {own, cfg} = await prepareLight();
        const targets = cfg.devices.filter(d => d.id !== own && d.introducedBy !== '' && d.introducer && !wantedIntroducer(d, policy.hardenIntroduced));
        for (const d of targets)
            await setIntroducer(d.id, false);
        if (targets.length > 0 && (await readConfig()).devices.some(d => targets.some(x => x.id === d.id) && d.introducer))
            throw new Fail('E_CLI_FAILED');
        return {result: {event: 'result', changed: targets.length}};
    }

    // `promote <ID>...`: the consent of a 0.2.5 pair (PLAN-0.2.6 F2): a directly accepted computer becomes an introducer. Refused while a removal
    // is open or in foreign-config; only directly accepted devices of the list.
    async function promote({ids = []} = {}) {
        const {own, cfg} = await prepareLight();
        if (foreignDevices(cfg.devices, own).length > 0 || folderAnomaly(cfg.folders, dirs.notes, cfg.overCap ? null : cfg.devices))
            throw new Fail('E_FOREIGN_DEVICE');
        refuseWhileClosed(cfg, own);
        namedIds(ids, cfg, own);
        const direct = ids.map(id => cfg.devices.find(d => d.id === id));
        if (direct.some(d => d === undefined || d.introducedBy !== ''))
            throw new Fail('E_BAD_ID');
        const targets = direct.filter(d => !d.introducer);
        for (const d of targets)
            await setIntroducer(d.id, true);
        if (targets.length > 0 && (await readConfig()).devices.some(d => targets.some(x => x.id === d.id) && !d.introducer))
            throw new Fail('E_CLI_FAILED');
        return {result: {event: 'result', changed: targets.length}};
    }

    // `ack <ID>...` | `ack --all`: the user has seen these computers and they are theirs. Only the state file changes. An ID that is not in the
    // list but is a tombstone of this computer is "add again" (PLAN-ADMISSION 2.4, Robert F7): the tombstone is lifted, so the computer is
    // offered by `host` when it knocks. Nothing else is touched, and a tombstoned computer that IS in the list stays a tombstone.
    async function ack({all = false, ids = []} = {}) {
        const {own, cfg} = await prepareLight();
        const ls = loadState();
        const lift = all ? [] : ids.filter(id => !cfg.ids.includes(id) && ls.state.tomb.includes(id));
        const named = all ? cfg.ids.filter(id => id !== own) : namedIds(ids, cfg, own, lift);
        const listed = named.filter(id => cfg.ids.includes(id));
        const fresh = listed.filter(id => !ls.state.ack.includes(id) && !(ls.missing && cfg.devices.find(d => d.id === id)?.introducedBy === ''));
        saveState(withoutTomb(withAck(ls.state, listed), lift), cfg, own);
        return {result: {event: 'result', changed: fresh.length + lift.length}};
    }


    // Starts the unit again, the way out of "does not answer" that touches no data: clear a failed state (the start limit of a crash loop), restart
    // (this also starts a unit that is not running: inactive, failed), wait for the daemon. The result is only that the daemon answers; the window
    // asks `status` afterwards. A unit that is DISABLED was switched off by the user (`forget --all --stop`): without `enable` nothing at all is run after
    // the read-only question and the result is state `disabled`; with `enable` (the user pressed the button) it is `enable --now` instead of `restart`.
    async function restart({enable = false} = {}) {
        if (!backendInstalled())
            throw new Fail('E_NO_SYNCTHING');
        if (!files.exists(configPath))
            throw new Fail('E_CLI_FAILED');
        let state = 'restarted';
        await step('service', async () => {
            recheckConfig();
            const was = await run.systemctl(['--user', 'is-enabled', UNIT_NAME], {timeoutMs: t.systemctlMs});
            const disabled = was.rc !== 0 && was.out.trim() === 'disabled';
            if (was.rc !== 0 && !disabled)
                throw new Fail('E_NO_USER_SYSTEMD');                              // masked, not found, timed out, unreadable: nothing is started (fail closed)
            if (disabled && !enable) {
                state = 'disabled';
                return;
            }
            await run.systemctl(['--user', 'reset-failed', UNIT_NAME], {timeoutMs: t.systemctlMs});     // nothing to clear is not an error
            const on = await run.systemctl(['--user', disabled ? 'enable' : 'restart', ...(disabled ? ['--now'] : []), UNIT_NAME], {timeoutMs: t.systemctlMs});
            if (on.rc !== 0)
                throw new Fail('E_NO_USER_SYSTEMD');
            if (!(await daemonAnswers(t.serviceWaitMs)))
                throw new Fail('E_SERVICE_TIMEOUT');
        });
        return {result: {event: 'result', state}};
    }

    // The quiet check at the start of the app on a computer that is set up (0.2.7; a `pkill -f cetli` stops the sync program with a clean exit and systemd,
    // which restarts only after a failure, leaves it stopped). The order is the contract: nothing without the program, the config and OUR folder; nothing when
    // systemd does not say plainly `enabled` (a unit the user switched off stays off; masked, not found, no answer: fail closed as in `restart`); the REAL state
    // first: a daemon that answers on our home is left alone, also when the unit says inactive (a parent that was killed leaves its child running, holding the
    // lock and the port: a second start would fail or loop); only a silent daemon with a unit that is `inactive` or `failed` is started (reset-failed, restart,
    // wait). A silent daemon of an active unit is not touched here: the window's own restart handles it. Result state: `running` (it answers), `started`,
    // `skipped` (nothing was done, the journal line says why).
    async function ensure() {
        const skipped = why => {
            log(`ensure: ${why}`);
            return {result: {event: 'result', state: 'skipped'}};
        };
        if (!backendInstalled() || !files.exists(configPath) || !holdsFolder())
            return skipped('no program, no instance or not our folder');
        const was = await run.systemctl(['--user', 'is-enabled', UNIT_NAME], {timeoutMs: t.systemctlMs});
        if (was.rc !== 0)
            return skipped(was.out.trim() === 'disabled' ? 'the unit is switched off' : 'systemd does not say enabled');
        if (await daemonAnswers(t.ensureWaitMs))
            return {result: {event: 'result', state: 'running'}};
        const act = await run.systemctl(['--user', 'is-active', UNIT_NAME], {timeoutMs: t.systemctlMs});
        const word = act.out.trim();
        if (word !== 'inactive' && word !== 'failed')
            return skipped('the unit is not stopped, the daemon does not answer');
        recheckConfig();
        await run.systemctl(['--user', 'reset-failed', UNIT_NAME], {timeoutMs: t.systemctlMs});
        const on = await run.systemctl(['--user', 'restart', UNIT_NAME], {timeoutMs: t.systemctlMs});
        if (on.rc !== 0)
            throw new Fail('E_NO_USER_SYSTEMD');
        if (!(await daemonAnswers(t.serviceWaitMs)))
            throw new Fail('E_SERVICE_TIMEOUT');
        return {result: {event: 'result', state: 'started'}};
    }

    // The way out when the daemon does not come back: back to "not set up", with NO call to the daemon. Stops and disables the unit, MOVES the
    // instance directory to a time-stamped name beside it (identity, key and config stay there, nothing is deleted), and takes away the marker
    // of our own folder (ownMarker) so that `setup` does not refuse. The notes directory and everything in it is never touched but that marker.
    async function reset() {
        if (dirs.home !== dedicatedHome(dirs.homeDir))
            throw new Fail('E_INTERNAL');
        const present = files.exists(dirs.home);
        if (present && (files.isSymlink(dirs.home) || !files.isDir(dirs.home)))
            throw new Fail('E_CONFIG_UNSAFE');
        const marker = present ? ownMarker() : null;
        await step('service', async () => {
            const off = await run.systemctl(['--user', 'disable', '--now', UNIT_NAME], {timeoutMs: t.systemctlMs});
            if (off.rc !== 0)
                throw new Fail('E_NO_USER_SYSTEMD');                         // nothing was changed
            await run.systemctl(['--user', 'reset-failed', UNIT_NAME], {timeoutMs: t.systemctlMs});      // so that the next start is not refused
        });
        if (present) {
            await step('instance', async () => {
                const stamp = new Date(ports.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
                let target = `${dirs.home}.bak-${stamp}`;
                for (let n = 1; files.exists(target) && n < 100; n++)
                    target = `${dirs.home}.bak-${stamp}-${n}`;
                if (files.exists(target))
                    throw new Fail('E_INTERNAL');
                try {
                    files.rename(dirs.home, target);
                } catch {
                    throw new Fail('E_CONFIG_UNSAFE');
                }
                log('reset: the instance directory was moved aside');
            });
        }
        if (marker !== null) {
            await step('folder', async () => {
                try {
                    const names = plainMarkerNames(marker.path);                // measured again now, not the list from before the unit was stopped
                    if (names === null) {
                        log('reset: the marker changed, it is left');
                        return;
                    }
                    for (const n of names)
                        files.removeFile(`${marker.path}/${n}`);
                    files.removeDir(marker.path);                              // only an empty directory goes
                } catch {
                    log('reset: the marker was not removed');                  // `setup` will then say E_STFOLDER_EXISTS: informative, nothing lost
                }
            });
        }
        return {result: {event: 'result', state: 'not-set-up'}};
    }


    // The common start of host and join: backend, instance, daemon, invariants, no removal open. Returns {own, cfg}.
    async function prepareConnect({forJoin = false} = {}) {
        if (!backendInstalled())
            throw new Fail('E_NO_SYNCTHING');
        if (!files.exists(configPath))
            throw new Fail('E_CLI_FAILED');
        recheckConfig();
        const own = await ownId();
        if (!(await daemonAnswers(t.statusWaitMs)))
            throw new Fail('E_SERVICE_TIMEOUT');
        const cfg = await readConfig();
        if (foreignDevices(cfg.devices, own).length > 0)
            throw new Fail('E_FOREIGN_DEVICE');
        if (folderAnomaly(cfg.folders, dirs.notes, cfg.overCap ? null : cfg.devices))
            throw new Fail('E_CONFIG_UNSAFE');
        refuseWhileClosed(cfg, own, {full: forJoin});
        return {own, cfg};
    }

    // The accept sequence (M-W7 (b)): the add (with the introducer role and the label), the share, then the read-back. The label is the sanitised
    // name of the candidate (displayName: 1-32 printable ASCII) as ONE `--name=` argument, or the fixed text. A computer that was accepted is
    // written into the acknowledged set; one the user types in again is no longer a tombstone.
    async function addPeer(peerId, own, label, {existing = false, recheck = false} = {}) {
        await step('device', async () => {
            if (recheck) {
                // `host` only (F4): the list is read again IMMEDIATELY before the add. A computer that is in it now (an introduction arrived since
                // the pending read) or that is a tombstone is never made a directly accepted one by a click, and the count is checked on the same read.
                const listed = lines(await cli(['config', 'devices', 'list']));
                if (listed.includes(peerId) || loadState().state.tomb.includes(peerId))
                    throw new Fail('E_PENDING_AMBIGUOUS');
                if (listed.length - 1 >= MAX_PEERS)
                    throw new Fail('E_GROUP_FULL');
            }
            await cli(['config', 'devices', 'add', '--device-id', peerId, '--introducer', `--name=${label}`]);
        });
        await step('share', async () => {
            await cli(['config', 'folders', FOLDER_ID, 'devices', 'add', '--device-id', peerId]);
            let cfg = await readConfig();                                    // rc 0 is not evidence that it was added (M-W1 row 4)
            let peer = cfg.devices.find(d => d.id === peerId);
            if (existing && peer && peer.introducedBy === '' && !peer.introducer) {
                // a repeated add changes nothing (M-W1 row 4): a device that was there already (the half pair of 0.2.5) keeps its old flag
                await setIntroducer(peerId, true);
                cfg = await readConfig();
                peer = cfg.devices.find(d => d.id === peerId);
            }
            const folder = cfg.folders.find(f => f.id === FOLDER_ID);
            if (!peer || !folder?.devices.some(d => d.id === peerId))
                throw new Fail('E_CLI_FAILED');
            if (foreignDevices(cfg.devices, own).length > 0 || folderAnomaly(cfg.folders, dirs.notes, cfg.devices))
                throw new Fail('E_FOREIGN_DEVICE');
            if (!peer.introducer || peer.introducedBy !== '')
                throw new Fail('E_CLI_FAILED');                              // the role was not set, or the device came in by introduction first
            const ls = loadState();
            saveState(withoutTomb(withAck(ls.state, [peerId]), [peerId]), cfg, own);
        });
    }

    const connectedResult = (peer, own, link) => ({event: 'result', peer, ...(own ? {own_id: own} : {}), connected: true, link: 'stable', connected_s: link.connectedS, up_to_date: null, notes: countNotes()});

    // `host`: wait for ONE computer, show it, accept exactly the ID the window names (0H.1, 0H.2). Any member can host, up to MAX_PEERS.
    async function host() {
        const {own, cfg} = await prepareConnect();
        if (cfg.overCap || peersOf(cfg, own).peers.length >= MAX_PEERS)
            throw new Fail('E_GROUP_FULL');                                  // before it listens
        const input = ports.input;
        const openedSecond = Math.floor(ports.now() / 1000) * 1000;
        const t0 = ports.monotonic();
        let lastPoll = -Infinity;
        let candidate = null;
        let accepted = false;
        let listedCount = 0;                                                  // devices in the list at the last pending read (own included)
        // the pending entries newer than the moment the window opened, and the one candidate among them (or null). A device that is in the list
        // NOW (an introduction arrives while the window is open, F4) and a tombstoned one are neither offered nor counted.
        async function pending() {
            const r = await run.syncthing('cli', ['show', 'pending', 'devices'], {maxBytes: PENDING_MAX_BYTES});
            if (r.tooLarge)
                throw new Fail('E_PENDING_TOO_LARGE');
            if (r.rc !== 0)
                throw new Fail('E_CLI_FAILED');
            const all = json(r.out);
            if (!isObj(all))
                throw new Fail('E_CLI_FAILED');
            const listed = new Set(lines(await cli(['config', 'devices', 'list'])));
            listedCount = listed.size;
            const tomb = loadState().state.tomb;
            // `time` has a one second resolution and is refreshed on every attempt (M-W10 d): an entry is fresh when its second is not older than
            // the second the window opened in.
            const fresh = Object.entries(all).filter(([id, e]) => isObj(e) && typeof e.time === 'string' && Date.parse(e.time) >= openedSecond && !listed.has(id) && !tomb.includes(id));
            if (fresh.length >= 2)
                throw new Fail('E_PENDING_AMBIGUOUS');
            if (fresh.length === 0)
                return null;
            const [id, e] = fresh[0];
            if (!isCanonicalId(id))
                return null;                                                 // an entry that fails the ID check is not a candidate
            return {id, name: displayName(e.name)};
        }
        for (;;) {
            if (input.eof())
                throw new Fail('E_EXPIRED');                                 // the window is gone: stop at once, accept nothing
            if (ports.monotonic() - t0 >= t.hostWindowMs)
                throw new Fail('E_EXPIRED');
            const wanted = [];
            for (const line of input.lines()) {
                const id = parseAcceptLine(line);
                if (id !== null && !accepted && wanted.length === 0)
                    wanted.push(id);                                         // a second accept is ignored; so is any other line
            }
            if (wanted.length === 1) {
                accepted = true;
                const now = await pending();                                  // fresh: the ID must STILL be the one candidate
                if (now === null || now.id !== wanted[0])
                    throw new Fail('E_PENDING_AMBIGUOUS');
                if (listedCount - 1 >= MAX_PEERS)
                    throw new Fail('E_GROUP_FULL');                              // an introduction filled the group while the window was open
                await addPeer(now.id, own, now.name ?? PEER_LABEL, {recheck: true});
                emit({event: 'peer', id: now.id, name: now.name});
                const link = await awaitStable(now.id, {stop: () => input.eof()});
                return {result: connectedResult({id: now.id, name: now.name}, null, link)};
            }
            if (!accepted && ports.monotonic() - lastPoll >= t.pendingPollMs) {
                lastPoll = ports.monotonic();
                const c = await pending();
                if (c !== null && (candidate === null || candidate.id !== c.id || candidate.name !== c.name)) {
                    candidate = c;
                    emit({event: 'candidate', id: c.id, name: c.name});
                }
            }
            await ports.sleep(t.tickMs);
        }
    }

    // `join`: the typed ID is added directly (no pending read). The line is canonicalised HERE, never by the window. Only a computer without
    // peers joins another one (a computer with peers that typed an ID could merge two groups and get round the count, T-N10); the same peer
    // again repairs a missing share (row 12).
    async function join(typed) {
        const {own, cfg} = await prepareConnect({forJoin: true});
        const parsed = parseTypedId(typed, own);
        if (!parsed.ok)
            throw new Fail(parsed.code);
        const peerId = parsed.id;
        const others = cfg.devices.filter(d => d.id !== own);
        if (others.length > 0 && !others.some(d => d.id === peerId))
            throw new Fail(others.some(d => peersOf(cfg, own).shared(d)) ? 'E_ALREADY_PAIRED' : 'E_HALF_STATE_OTHER');
        if (!others.some(d => d.id === peerId) || !peersOf(cfg, own).shared({id: peerId}))
            await addPeer(peerId, own, PEER_LABEL, {existing: others.some(d => d.id === peerId)});        // a new peer, or the same one with the share missing (row 12)
        emit({event: 'peer', id: peerId, name: null});
        const link = await awaitStable(peerId);
        return {result: connectedResult({id: peerId, name: null}, own, link)};
    }

    // ---- the one entry the dispatcher uses -------------------------------------------------------------------------------

    async function perform(verb, arg) {
        try {
            switch (verb) {
            case 'status': return await status();
            case 'setup': return await setup();
            case 'own-id': return await ownIdVerb();
            case 'forget': return await forget(arg ?? {});
            case 'revoke': return await revoke(arg ?? {});
            case 'finish': return await finish();
            case 'harden': return await harden();
            case 'promote': return await promote(arg ?? {});
            case 'ack': return await ack(arg ?? {});
            case 'restart': return await restart(arg ?? {});
            case 'ensure': return await ensure();
            case 'reset': return await reset();
            case 'host': return await host();
            case 'join': return await join(arg);
            default: return {error: {code: 'E_INTERNAL'}};
            }
        } catch (e) {
            if (e instanceof Fail) {
                log(`${verb}: ${e.code}${e.step ? ` (${e.step})` : ''}`);
                return {error: {code: e.code, ...(e.step ? {step: e.step} : {})}};
            }
            log(`${verb}: internal error`);                                  // never the message: it may carry text of a file
            return {error: {code: 'E_INTERNAL'}};
        }
    }

    return {perform, status, setup, forget, restart, ensure, reset, host, join, revoke, finish, harden, promote, ack, foreignDevices};
}
