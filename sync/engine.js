// SPDX-License-Identifier: GPL-3.0-or-later
// The engine of the sync window (PLAN-WIZARD 0H, 0F, 7.2; PLAN-WIZARD-INTERFACE 2a, 3): the verbs status, setup, own-id, forget, host and join.
// No Gio, no process, no file API of its own: everything is injected (`ports`), so a stub Syncthing and a stub file system run it in node.
// What it never does: read or write the notes, read a foreign config, call the REST interface or touch an API key (it uses `syncthing cli` only),
// remove a device it did not add, remove the folder or a file, or put anything of a peer (name, address) on a command line or in a log.
//
// ports = {
//   run:      createRunPort(...)        syncthing(sub, args, opts) -> {rc, out, tooLarge?}, systemctl(args, opts)
//   files:    {exists(p), readText(p), writeText(p, text, mode), mkdirp(p, mode), modeOf(p), isDir(p), isSymlink(p), listNames(p)}
//   dirs:     {homeDir, notes, home}    the user's home, the core's notes directory, the dedicated instance's home
//   now(), monotonic(), sleep(ms)       wall clock ms, monotonic ms, a timer
//   input:    {lines() -> string[], eof() -> bool}       host only: what the window wrote on stdin
//   emit(event), log(text)              events of the protocol (without v), a journal line (codes and field names only)
//   timing?:  overrides of the constants below (tests)
// }
import {NAME_MAIN} from '../src/constants.js';
import {ConfigEditError, PORTS_OWN, editConfig, readFolderIds, verifyConfig} from './confedit.js';
import {canonicalId, displayName, isCanonicalId, parseTypedId} from './ids.js';
import {markerPaths} from './markers.js';
import {BACKEND_EXE, FOLDER_ID, UNIT_NAME, socketPath} from './paths.js';
import {parseAcceptLine} from './protocol.js';

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
});
export const PENDING_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_PEERS = 1;                // one peer (0A row 11); Nicole's N-peer rule replaces this number and the predicate below
export const PEER_LABEL = 'other computer';

class Fail extends Error {
    constructor(code, step = null) {
        super(code);
        this.code = code;
        this.step = step;
    }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ONE predicate for setup, host, join, the accept step and status (Interface 2a): a device is foreign when it is a second introducer, was
// introduced, auto-accepts folders, or is a peer beyond the allowed number. The engine never removes such an entry itself.
export function foreignDevices(devices, ownId, maxPeers = MAX_PEERS) {
    const others = devices.filter(d => d.id !== ownId);
    const peers = others.length <= maxPeers ? others : [];
    return devices.filter(d => d.introducer || d.autoAcceptFolders || d.introducedBy !== '' || (d.id !== ownId && !peers.includes(d)));
}

// The folder set of the dedicated instance must be exactly {cetli-notes}: absolute path equal to the notes path, send-receive, shared with no
// introduced device (7.2, T14). Returns true when something is wrong.
export function folderAnomaly(folders, notesPath) {
    if (folders.length !== 1 || folders[0].id !== FOLDER_ID)
        return true;
    const f = folders[0];
    return f.path !== notesPath || !f.path.startsWith('/') || f.type !== 'sendreceive' || f.devices.some(d => d.introducedBy !== '');
}

export function createEngine(ports) {
    const {run, files, dirs, emit, log} = ports;
    const t = {...TIMING, ...(ports.timing ?? {})};
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
        if (r.tooLarge)
            throw new Fail('E_PENDING_TOO_LARGE');
        if (r.rc !== 0)
            throw new Fail('E_CLI_FAILED');
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
            return readFolderIds(files.readText(configPath)).includes(FOLDER_ID);
        } catch {
            return false;
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

    // The read-back of the instance: every device with its flags, every folder with its path, type and devices (M-W1 commands).
    async function readConfig() {
        const devices = [];
        for (const id of lines(await cli(['config', 'devices', 'list']))) {
            if (!isCanonicalId(id))
                throw new Fail('E_CLI_FAILED');
            const d = json(await cli(['config', 'devices', id, 'dump-json']));
            if (!isObj(d) || d.deviceID !== id)
                throw new Fail('E_CLI_FAILED');
            devices.push({id, introducer: d.introducer === true, autoAcceptFolders: d.autoAcceptFolders === true, introducedBy: typeof d.introducedBy === 'string' ? d.introducedBy : 'invalid'});
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
        return {devices, folders};
    }

    function countNotes() {
        try {
            return files.listNames(dirs.notes).filter(n => NAME_MAIN.test(n)).length;
        } catch {
            return null;
        }
    }

    // Own ID aside, the single peer of the instance and whether the folder is shared with it.
    function peersOf(cfg, own) {
        const peers = cfg.devices.filter(d => d.id !== own);
        const folder = cfg.folders.find(f => f.id === FOLDER_ID);
        return {peers, shared: peer => folder?.devices.some(d => d.id === peer.id) ?? false};
    }

    // ---- the link (Interface 3, `link` and the "Connected" claim) -------------------------------------------------------

    async function readConnected(peerId) {
        const o = json(await cli(['show', 'connections']));
        const c = o?.connections?.[peerId];
        return isObj(c) ? c.connected === true : false;
    }

    // A tracker for ONE peer. Raw `connected` is never proof (M-W6): `stable` is `linkSamples` CONSECUTIVE connected samples taken
    // `linkGapMs` apart on the monotonic clock (Interface 3, option (a) of 0G.2; there is no `cli` completion, so nothing says "synced").
    // A failed or timed-out call, a not-connected sample, or a gap of more than twice `linkGapMs` between two samples restarts the count.
    // `connectedS` is the length of the unbroken run this engine saw, first to last sample, in whole seconds; null unless stable.
    function createLinkTracker(peerId) {
        let consecutive = 0;
        let runStart = null;
        let lastAt = null;
        let everConnected = false;
        const v = {link: 'none', connectedS: null, connected: false};
        return {
            get value() { return {...v}; },
            async sample() {
                let connected = false;
                try {
                    connected = await readConnected(peerId);
                } catch (e) {
                    if (!(e instanceof Fail))
                        throw e;                                              // a failed call is a broken sample, not the end of the run
                }
                const at = ports.monotonic();
                if (lastAt !== null && at - lastAt > 2 * t.linkGapMs)
                    consecutive = 0;
                lastAt = at;
                v.connected = connected;
                if (!connected) {
                    consecutive = 0;
                    v.link = everConnected ? 'flapping' : 'none';
                    v.connectedS = null;
                    return {...v};
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
                return {...v};
            },
        };
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

    // status: the first not-connected sample ends the run; only the success path pays the K samples.
    async function measureLink(peerId) {
        const tracker = createLinkTracker(peerId);
        for (let i = 0; i < t.linkSamples + 1; i++) {
            const s = await tracker.sample();
            if (!s.connected || s.link === 'stable')
                return s;
            if (i < t.linkSamples)
                await ports.sleep(t.linkGapMs);
        }
        return tracker.value;
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

    async function status() {
        const base = {event: 'result', state: 'not-set-up', own_id: null, peer: null, connected: null, link: null, connected_s: null, listener: null, shared: null, up_to_date: null, notes: null, waiting: false};
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
        const foreign = foreignDevices(cfg.devices, own).length > 0 || folderAnomaly(cfg.folders, dirs.notes);
        const {peers, shared} = peersOf(cfg, own);
        const peer = peers[0] ?? null;
        if (foreign)
            return {result: {...base, state: 'foreign-config', own_id: own}};
        const listener = await listenerState();
        if (peer === null)
            return {result: {...base, state: 'set-up', own_id: own, listener, notes: countNotes()}};
        const isShared = shared(peer);
        const m = await measureLink(peer.id);
        return {result: {
            ...base, state: isShared ? 'paired' : 'half', own_id: own, peer: {id: peer.id, name: null}, connected: m.connected, link: m.link,
            connected_s: m.connectedS, listener, shared: isShared, up_to_date: null, notes: countNotes(),
        }};
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
            if (folderAnomaly(cfg.folders, dirs.notes))
                throw new Fail('E_CONFIG_UNSAFE');
        });
        return {result: {event: 'result', own_id: own, state: 'set-up'}};
    }

    async function ownIdVerb() {
        if (!backendInstalled())
            throw new Fail('E_NO_SYNCTHING');
        return {result: {event: 'result', own_id: await ownId()}};
    }

    // Removes the device and its share, never the folder, never a file, never the instance (D1). `--stop` also disables the unit.
    async function forget({stop = false} = {}) {
        if (!backendInstalled())
            throw new Fail('E_NO_SYNCTHING');
        if (!files.exists(configPath))
            return {result: {event: 'result', state: 'set-up'}};
        const own = await ownId();
        if (!(await daemonAnswers(t.statusWaitMs)))
            throw new Fail('E_SERVICE_TIMEOUT');
        const cfg = await step('device', async () => {
            const c = await readConfig();
            if (foreignDevices(c.devices, own).length > 0)
                throw new Fail('E_FOREIGN_DEVICE');
            return c;
        });
        const {peers, shared} = peersOf(cfg, own);
        if (peers.length > 0) {
            const peer = peers[0];
            await step('share', async () => {
                if (shared(peer))
                    await cli(['config', 'folders', FOLDER_ID, 'devices', peer.id, 'delete']);
                await cli(['config', 'devices', peer.id, 'delete']);
                const after = await readConfig();                           // read back: what IS
                if (after.devices.some(d => d.id === peer.id) || after.folders.some(f => f.devices.some(d => d.id === peer.id)))
                    throw new Fail('E_CLI_FAILED');
                if (!after.folders.some(f => f.id === FOLDER_ID))
                    throw new Fail('E_INTERNAL');
            });
        }
        if (stop) {
            const off = await run.systemctl(['--user', 'disable', '--now', UNIT_NAME]);
            if (off.rc !== 0)
                throw new Fail('E_NO_USER_SYSTEMD');
        }
        return {result: {event: 'result', state: 'set-up'}};
    }

    // The common start of host and join: backend, instance, daemon, invariants. Returns {own, cfg}.
    async function prepareConnect() {
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
        if (folderAnomaly(cfg.folders, dirs.notes))
            throw new Fail('E_CONFIG_UNSAFE');
        return {own, cfg};
    }

    // The accept sequence (M-W7 (b)): two calls, then the read-back. The peer label is the fixed text, never the pending name.
    async function addPeer(peerId, own) {
        await step('device', async () => {
            await cli(['config', 'devices', 'add', '--device-id', peerId, `--name=${PEER_LABEL}`]);
        });
        await step('share', async () => {
            await cli(['config', 'folders', FOLDER_ID, 'devices', 'add', '--device-id', peerId]);
            const cfg = await readConfig();                                  // rc 0 is not evidence that it was added (M-W1 row 4)
            const peer = cfg.devices.find(d => d.id === peerId);
            const folder = cfg.folders.find(f => f.id === FOLDER_ID);
            if (!peer || !folder?.devices.some(d => d.id === peerId))
                throw new Fail('E_CLI_FAILED');
            if (foreignDevices(cfg.devices, own).length > 0 || folderAnomaly(cfg.folders, dirs.notes))
                throw new Fail('E_FOREIGN_DEVICE');
        });
    }

    const connectedResult = (peer, own, link) => ({event: 'result', peer, ...(own ? {own_id: own} : {}), connected: true, link: 'stable', connected_s: link.connectedS, up_to_date: null, notes: countNotes()});

    // `host`: wait for ONE computer, show it, accept exactly the ID the window names (0H.1, 0H.2).
    async function host() {
        const {own, cfg} = await prepareConnect();
        if (cfg.devices.some(d => d.id !== own))
            throw new Fail('E_ALREADY_PAIRED');
        const input = ports.input;
        const openedSecond = Math.floor(ports.now() / 1000) * 1000;
        const t0 = ports.monotonic();
        let lastPoll = -Infinity;
        let candidate = null;
        let accepted = false;
        const known = new Set(cfg.devices.map(d => d.id));
        // the pending entries newer than the moment the window opened, and the one candidate among them (or null)
        async function pending() {
            const r = await run.syncthing('cli', ['show', 'pending', 'devices'], {maxBytes: PENDING_MAX_BYTES});
            if (r.tooLarge)
                throw new Fail('E_PENDING_TOO_LARGE');
            if (r.rc !== 0)
                throw new Fail('E_CLI_FAILED');
            const all = json(r.out);
            if (!isObj(all))
                throw new Fail('E_CLI_FAILED');
            // `time` has a one second resolution and is refreshed on every attempt (M-W10 d): an entry is fresh when its second is not older than
            // the second the window opened in.
            const fresh = Object.entries(all).filter(([, e]) => isObj(e) && typeof e.time === 'string' && Date.parse(e.time) >= openedSecond);
            if (fresh.length >= 2)
                throw new Fail('E_PENDING_AMBIGUOUS');
            if (fresh.length === 0)
                return null;
            const [id, e] = fresh[0];
            if (!isCanonicalId(id) || id === own || known.has(id))
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
                await addPeer(now.id, own);
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

    // `join`: the typed ID is added directly (no pending read). The line is canonicalised HERE, never by the window.
    async function join(typed) {
        const {own, cfg} = await prepareConnect();
        const parsed = parseTypedId(typed, own);
        if (!parsed.ok)
            throw new Fail(parsed.code);
        const peerId = parsed.id;
        const others = cfg.devices.filter(d => d.id !== own);
        if (others.length > 0 && !others.some(d => d.id === peerId))
            throw new Fail(others.some(d => peersOf(cfg, own).shared(d)) ? 'E_ALREADY_PAIRED' : 'E_HALF_STATE_OTHER');
        if (!others.some(d => d.id === peerId) || !peersOf(cfg, own).shared({id: peerId}))
            await addPeer(peerId, own);                                      // a new peer, or the same one with the share missing (row 12)
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

    return {perform, status, setup, forget, host, join, foreignDevices};
}
