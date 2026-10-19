// SPDX-License-Identifier: GPL-3.0-or-later
// A stateful stub of the machine the engine runs on: an in-memory file system, a systemd that starts a stub Syncthing daemon, and the
// `syncthing cli` commands the engine uses with the output formats measured by John (M-W1, M-W6, M-W7, M-W10). Virtual time: `sleep` advances
// the clocks and fires the events scheduled with `world.at(ms, fn)`, so a five minute timeout costs no real time.
// It is a test double, not a model of Syncthing: where Syncthing was not measured, the stub does the simplest thing and says so.
import {readFileSync} from 'node:fs';
import {createEngine} from '../../sync/engine.js';
import {createRunPort} from '../../sync/runport.js';
import {dedicatedHome} from '../../sync/paths.js';
import {isCanonicalId} from '../../sync/ids.js';

export const OWN = 'F6HEWOE-4KSACQ5-5MAX7IC-HAP3EGW-AQYBTIX-V74MXIF-ZB3GZN6-4T3QYQZ';
export const PEER = 'VTTWEJK-SMIOBMH-3FIWS7V-JFC2CL4-FCR3BU6-PEPADRQ-EYVVD3Z-BIGMUQ5';
export const OTHER = 'TKIBGPF-WSGKBIH-LXXRQZX-HYOCM6Y-T6IYH5B-5CNPJLR-UHMG75U-JXHXVQP';
export const THIRD = 'IZA3FNQ-S6ZB6SZ-KJXJ4MB-KUYXPYA-MYWCRPI-TSVUXR2-CRK2SYT-YGUA6QZ';
export const FAKE_KEY = 'FAKEKEY-do-not-leak-0123456789';

const GENERATED = readFileSync(new URL('../fixtures/config-generated.xml', import.meta.url), 'utf8');
const dirOf = p => p.slice(0, p.lastIndexOf('/')) || '/';

export function createWorld(opts = {}) {
    const homeDir = opts.homeDir ?? '/home/u';
    const notes = opts.notes ?? `${homeDir}/.local/share/cetli/notes`;
    const home = dedicatedHome(homeDir);
    const w = {
        homeDir, notes, home, calls: [], sleeps: 0, journal: [], events: [], timeline: [],
        clock: 1_800_000_000_000, mono: 0,
        systemd: opts.systemd ?? true,            // `systemctl --user` works
        daemon: false,                             // the stub Syncthing is running
        startDelayMs: opts.startDelayMs ?? 0,      // the daemon answers this long after the unit is enabled
        startedAt: null,
        devices: new Map(),                        // id -> {name, introducer, autoAcceptFolders, introducedBy}
        folders: new Map(),                        // id -> {path, type, devices: [{id, introducedBy}], argv}
        connections: new Map(),                    // id -> boolean | (nowMs) -> boolean
        pending: {},                               // id -> {time, name, address}
        pendingBytes: null,                        // pretend the output is this large
        system: null,                              // (world) -> {rc, out}: a different answer of `show system`
        failConnections: null,                     // (nowMs) -> boolean: `show connections` fails (rc 1) when true
        afterAdd: null,                            // (id) -> void: a hook that changes a device right after it was added (a foreign edit)
        keepDevices: new Set(),                    // ids whose `devices <ID> delete` answers rc 0 and changes nothing (a delete that did not hold)
        noIntroducerSet: false,                    // `introducer set` answers rc 0 and changes nothing (a daemon that does not hold the flag)
        remoteLists: [],                           // [{by, id, name}]: a computer `by` that still lists `id`: while `by` is a device here with introducer=true,
                                                   // `id` is added again (as an introduced device) after a delete and whenever a second or more passes (PLAN-0.2.6 5)
        hung: false,                               // the unit is active but the daemon never answers (the failure of 0.2.5.2)
        enabled: true,                             // `systemctl --user is-enabled`: false = the unit was disabled by the user (`forget --all --stop`)
        orphan: false,                             // a daemon runs and answers but the unit is inactive (its parent was killed: the child holds the lock and the port)
        orphanAt: 0,                               // an orphan child answers from this virtual time on (a slow one: the lock and the port are taken, the API is not up yet)
        activating: false,                         // the unit is on its way up (`is-active` says activating, rc 3) and the daemon does not answer yet
        unitFailed: false,                         // the unit is in the failed state (start limit): starting it is refused until `reset-failed`
        afterDisable: null,                        // (world) -> void: runs while `systemctl --user disable` is working (a path swapped during the wait)
        failSystemctl: new Set(),                  // `systemctl` argument strings (after --user) that fail with rc 1
        failCli: new Set(),                        // exact `config devices add`-style prefixes that fail (rc 1)
        ownId: opts.ownId ?? OWN,
    };
    const fsMap = new Map();                       // path -> {dir: bool, text, mode, link}
    const ensureDir = (p, mode = 0o755) => {
        if (!fsMap.has(p))
            fsMap.set(p, {dir: true, mode});
    };
    const files = {
        exists: p => fsMap.has(p),
        readText: p => {
            const f = fsMap.get(p);
            if (!f || f.dir)
                throw new Error('ENOENT');
            return f.text;
        },
        writeText: (p, text, mode) => {
            ensureDir(dirOf(p));
            fsMap.set(p, {dir: false, text, mode});
            w.timeline.push(`write ${p}`);
        },
        mkdirp: (p, mode) => {
            const parts = p.split('/').filter(Boolean);
            let cur = '';
            for (const part of parts) {
                cur += `/${part}`;
                if (!fsMap.has(cur))
                    fsMap.set(cur, {dir: true, mode: cur === p ? mode : 0o755});
            }
        },
        modeOf: p => fsMap.get(p)?.mode ?? null,
        isDir: p => fsMap.get(p)?.dir === true,
        isSymlink: p => fsMap.get(p)?.link === true,
        listNames: p => [...fsMap.keys()].filter(k => dirOf(k) === p).map(k => k.slice(p.length + 1)),
        // `reset` only: a move within one parent, the removal of one file, the removal of one EMPTY directory (as the real ports do)
        rename: (from, to) => {
            if (!fsMap.has(from) || fsMap.has(to) || dirOf(from) !== dirOf(to))
                throw new Error('rename failed');
            for (const k of [...fsMap.keys()].filter(k => k === from || k.startsWith(`${from}/`))) {
                fsMap.set(to + k.slice(from.length), fsMap.get(k));
                fsMap.delete(k);
            }
            w.timeline.push(`rename ${from} ${to}`);
        },
        removeFile: p => {
            if (!fsMap.has(p) || fsMap.get(p).dir)
                throw new Error('remove failed');
            fsMap.delete(p);
            w.timeline.push(`remove ${p}`);
        },
        removeDir: p => {
            if (!fsMap.get(p)?.dir || [...fsMap.keys()].some(k => dirOf(k) === p))
                throw new Error('rmdir failed');
            fsMap.delete(p);
            w.timeline.push(`rmdir ${p}`);
        },
    };
    // the machine
    fsMap.set('/', {dir: true, mode: 0o755});
    ensureDir(homeDir);
    ensureDir(notes);
    if (opts.backend !== false)
        fsMap.set('/usr/bin/syncthing', {dir: false, text: '', mode: 0o755});
    w.files = files;
    w.fsMap = fsMap;
    w.put = (path, text = '', mode = 0o644) => { ensureDir(dirOf(path)); fsMap.set(path, {dir: false, text, mode}); };
    w.mkdir = (path, mode = 0o755) => files.mkdirp(path, mode);
    w.note = (n = 1) => { for (let i = 0; i < n; i++) w.put(`${notes}/0000000${i}-0000-4000-8000-000000000000.json`, '{}'); };

    // ---- the stub Syncthing ----------------------------------------------------------------------------------------------
    const configXml = () => fsMap.get(`${home}/config.xml`)?.text;
    const syncFolderElements = () => {
        // keep the folder ids in config.xml in step with the stub (Syncthing rewrites the file after a change)
        const f = fsMap.get(`${home}/config.xml`);
        if (!f)
            return;
        const base = f.text.replace(/\n {4}<folder id="[^"]*"[\s\S]*?\n {4}<\/folder>/g, '');
        const elems = [...w.folders.keys()].map(id => `\n    <folder id="${id}" label="cetli" path="${w.folders.get(id).path}" type="${w.folders.get(id).type}">\n    </folder>`).join('');
        f.text = base.replace(/(<configuration version="52">)/, `$1${elems}`);
    };
    const daemonUp = () => w.orphan && w.mono >= w.orphanAt || w.daemon && !w.hung && (w.startedAt === null || w.mono - w.startedAt >= w.startDelayMs);
    const lines = a => `${a.join('\n')}\n`;
    const devJson = id => {
        const d = w.devices.get(id);
        return JSON.stringify({deviceID: id, name: d.name, addresses: ['dynamic'], compression: 'metadata', certName: '', introducer: d.introducer, skipIntroductionRemovals: d.skipIntroductionRemovals === true,
            introducedBy: d.introducedBy, paused: false, allowedNetworks: [], autoAcceptFolders: d.autoAcceptFolders, maxSendKbps: 0, maxRecvKbps: 0, ignoredFolders: [], maxRequestKiB: 0,
            untrusted: false, remoteGUIPort: 0, numConnections: 0, group: ''}, null, 2);
    };
    const folderJson = id => {
        const f = w.folders.get(id);
        return JSON.stringify({id, label: 'cetli', filesystemType: 'basic', path: f.path, type: f.type, devices: f.devices.map(d => ({deviceID: d.id, introducedBy: d.introducedBy, encryptionPassword: ''})),
            group: '', rescanIntervalS: 3600, fsWatcherEnabled: true, fsWatcherDelayS: 1, ignorePerms: true, maxConflicts: -1}, null, 2);
    };
    const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const eq = (args, prefix) => args.find(a => a.startsWith(prefix))?.slice(prefix.length);

    // A computer that still lists a device brings it back while we take introductions from it (the introducer flag is on for it): the
    // device and its share come back as introduced by that computer [M 133, 219]. Called after every delete and after every sleep of a
    // second or more, so a removal in the WRONG order (delete before the flags are off) is undone visibly.
    function reintroduce() {
        for (const {by, id, name} of w.remoteLists) {
            if (!w.devices.get(by)?.introducer || w.devices.has(id))
                continue;
            w.devices.set(id, {name: name ?? 'introduced', introducer: true, autoAcceptFolders: false, introducedBy: by});
            const f = w.folders.get('cetli-notes');
            if (f && !f.devices.some(x => x.id === id))
                f.devices.push({id, introducedBy: by});
        }
    }

    function cli(args) {
        if (!daemonUp())
            return {rc: 1, out: `syncthing: error: Get "http://unix/rest/system/config": dial unix ${home}/gui.sock: connect: no such file or directory\n`};
        const [a, b, c, d, e] = args;
        if (a === 'show' && b === 'system')
            return w.system ? w.system(w) : {rc: 0, out: JSON.stringify({myID: w.ownId, connectionServiceStatus: {}}) + '\n'};
        if (a === 'show' && b === 'connections') {
            if (w.failConnections?.(w.mono))
                return {rc: 1, out: 'syncthing: error: timeout\n'};
            const connections = {};
            for (const id of w.devices.keys()) {
                if (id === w.ownId)
                    continue;
                const v = w.connections.get(id);
                connections[id] = {connected: typeof v === 'function' ? v(w.mono) : v === true};
            }
            return {rc: 0, out: JSON.stringify({connections, total: {}}, null, 2)};
        }
        if (a === 'show' && b === 'pending' && c === 'devices') {
            let out = JSON.stringify(w.pending, null, 2);
            if (w.pendingBytes !== null)
                out += ' '.repeat(w.pendingBytes);
            return {rc: 0, out};
        }
        if (a !== 'config')
            return {rc: 1, out: 'syncthing: error: unknown command\n'};
        const key = args.slice(1).join(' ');
        for (const f of w.failCli) {
            if (key.startsWith(f))
                return {rc: 1, out: 'syncthing: error: refused\n'};
        }
        if (b === 'devices' && c === 'list')
            return {rc: 0, out: lines([...w.devices.keys()])};
        if (b === 'devices' && c === 'add') {
            const id = flag(args, '--device-id');
            if (!isCanonicalId(id))
                return {rc: 1, out: `syncthing: error: "${id}": check digit incorrect\n`};
            if (!w.devices.has(id)) {
                w.devices.set(id, {name: eq(args, '--name=') ?? flag(args, '--name') ?? '', introducer: args.includes('--introducer'), autoAcceptFolders: false, introducedBy: ''});
                delete w.pending[id];
                w.afterAdd?.(id);
            }
            return {rc: 0, out: ''};                                    // a repeated add: rc 0, nothing changes (M-W1 row 4)
        }
        if (b === 'devices' && isCanonicalId(c) && d === 'dump-json')
            return w.devices.has(c) ? {rc: 0, out: devJson(c)} : {rc: 3, out: `No help topic for '${c}'\n`};
        if (b === 'devices' && isCanonicalId(c) && d === 'delete') {
            if (!w.keepDevices.has(c))
                w.devices.delete(c);
            reintroduce();
            return {rc: 0, out: ''};
        }
        if (b === 'devices' && isCanonicalId(c) && d === 'introducer' && e === 'set') {
            if (!w.devices.has(c))
                return {rc: 3, out: `No help topic for '${c}'\n`};
            if (!w.noIntroducerSet)
                w.devices.get(c).introducer = args[5] === 'true';
            return {rc: 0, out: ''};
        }
        if (b === 'devices' && isCanonicalId(c) && d === 'skip-introduction-removals' && e === 'set') {
            if (!w.devices.has(c))
                return {rc: 3, out: `No help topic for '${c}'\n`};
            w.devices.get(c).skipIntroductionRemovals = args[5] === 'true';
            return {rc: 0, out: ''};
        }
        if (b === 'folders' && c === 'list')
            return {rc: 0, out: lines([...w.folders.keys()])};
        if (b === 'folders' && c === 'add') {
            const id = flag(args, '--id');
            w.folders.set(id, {path: flag(args, '--path'), type: flag(args, '--type') ?? 'sendreceive', devices: [{id: w.ownId, introducedBy: ''}], argv: args});
            w.mkdir(`${flag(args, '--path')}/.stfolder`);                // Syncthing makes the marker (M log 32): a directory
            syncFolderElements();
            return {rc: 0, out: ''};
        }
        if (b === 'folders' && w.folders.has(c) && d === 'dump-json')
            return {rc: 0, out: folderJson(c)};
        if (b === 'folders' && w.folders.has(c) && d === 'devices' && e === 'add') {
            const id = flag(args, '--device-id');
            const f = w.folders.get(c);
            if (!f.devices.some(x => x.id === id))
                f.devices.push({id, introducedBy: ''});
            return {rc: 0, out: ''};
        }
        if (b === 'folders' && w.folders.has(c) && d === 'devices' && isCanonicalId(e) && args[5] === 'delete') {
            const f = w.folders.get(c);
            f.devices = f.devices.filter(x => x.id !== e);
            reintroduce();
            return {rc: 0, out: ''};
        }
        return {rc: 1, out: 'syncthing: error: unsupported by the stub\n'};
    }

    const spawn = async (argv, env, spawnOpts) => {
        w.calls.push({argv, env, opts: spawnOpts});
        const [exe, sub, ...rest] = argv;
        if (exe === '/usr/bin/systemctl') {
            if (!w.systemd)
                return {rc: 1, out: 'Failed to connect to bus\n'};
            const key = argv.slice(1).join(' ');
            if (w.failSystemctl.has(key.replace('--user ', '')))
                return {rc: 1, out: 'Failed\n'};
            if (key === `--user is-enabled cetli-syncthing.service`) {
                w.timeline.push('systemctl is-enabled');
                return w.enabled ? {rc: 0, out: 'enabled\n'} : {rc: 1, out: 'disabled\n'};
            }
            if (key === `--user is-active cetli-syncthing.service`) {
                w.timeline.push('systemctl is-active');
                return w.daemon && !w.orphan ? {rc: 0, out: 'active\n'} : w.activating ? {rc: 3, out: 'activating\n'} : w.unitFailed ? {rc: 3, out: 'failed\n'} : {rc: 3, out: 'inactive\n'};
            }
            if (key === `--user reset-failed cetli-syncthing.service`) {
                w.unitFailed = false;
                w.timeline.push('systemctl reset-failed');
                return {rc: 0, out: ''};
            }
            if (key === `--user restart cetli-syncthing.service`) {
                w.timeline.push('systemctl restart');
                if (w.unitFailed)
                    return {rc: 1, out: 'Failed to restart: start request repeated too quickly\n'};
                w.daemon = true;
                w.startedAt = w.mono;
                return {rc: 0, out: ''};
            }
            if (key === `--user enable --now cetli-syncthing.service`) {
                if (w.unitFailed)
                    return {rc: 1, out: 'Failed to enable: start request repeated too quickly\n'};
                w.daemon = true;
                w.enabled = true;
                w.startedAt = w.mono;
                w.timeline.push('systemctl enable --now');
                return {rc: 0, out: ''};
            }
            if (key.startsWith('--user disable')) {
                w.afterDisable?.(w);
                w.daemon = false;
                w.enabled = false;
                w.timeline.push('systemctl disable');
                return {rc: 0, out: ''};
            }
            return {rc: 0, out: ''};
        }
        const args = rest.filter(a => !a.startsWith('--home='));
        if (sub === 'generate') {
            w.timeline.push('generate');
            w.mkdir(home, 0o700);
            w.put(`${home}/cert.pem`, '', 0o644);
            w.put(`${home}/key.pem`, '', 0o600);
            w.put(`${home}/config.xml`, GENERATED.replace(/<apikey>[^<]*<\/apikey>/, `<apikey>${FAKE_KEY}</apikey>`), 0o600);
            w.devices.clear();                                           // a new instance knows no device and no folder
            w.folders.clear();
            w.devices.set(w.ownId, {name: 'machine', introducer: false, autoAcceptFolders: false, introducedBy: ''});
            return {rc: 0, out: `INF Calculated device ID (device=${w.ownId})\n`};
        }
        if (sub === 'device-id')
            return files.exists(`${home}/cert.pem`) ? {rc: 0, out: `${w.ownId}\n`} : {rc: 1, out: 'no certificate\n'};
        if (sub === 'cli') {
            w.timeline.push(`cli ${args.slice(0, 4).join(' ')}`);
            return cli(args);
        }
        return {rc: 1, out: ''};
    };

    const run = createRunPort({spawn, hostEnv: opts.hostEnv ?? {PATH: '/usr/bin', HOME: homeDir, STGUIADDRESS: '127.0.0.1:9', STGUIAPIKEY: 'caller-key', STHOMEDIR: '/other'}, home});
    w.run = run;

    // ---- time -----------------------------------------------------------------------------------------------------------
    const scheduled = [];
    w.at = (ms, fn) => scheduled.push({at: ms, fn, done: false});
    const tickTo = target => {
        for (;;) {
            const due = scheduled.filter(s => !s.done && s.at <= target).sort((x, y) => x.at - y.at)[0];
            if (!due)
                break;
            due.done = true;
            w.mono = Math.max(w.mono, due.at);
            due.fn(w);
        }
        w.clock += target - w.mono;
        w.mono = target;
    };
    const stdin = {queue: [], eofFlag: false};
    w.stdin = stdin;
    w.write = line => stdin.queue.push(line);
    w.eof = () => { stdin.eofFlag = true; };

    w.ports = () => ({
        run, files, dirs: {homeDir, notes, home}, now: () => w.clock, monotonic: () => w.mono,
        sleep: async ms => { w.sleeps++; tickTo(w.mono + ms); if (ms >= 1000) reintroduce(); },
        input: {lines: () => stdin.queue.splice(0), eof: () => stdin.eofFlag},
        emit: ev => w.events.push(ev),
        log: m => w.journal.push(m),
        timing: opts.timing,
        policy: opts.policy,
    });
    w.engine = () => createEngine(w.ports());
    // convenience for the states a test starts from
    w.installBackend = () => fsMap.set('/usr/bin/syncthing', {dir: false, text: '', mode: 0o755});
    w.setUp = async () => {
        const r = await w.engine().perform('setup');
        w.events.length = 0;
        w.calls.length = 0;
        w.timeline.length = 0;
        w.journal.length = 0;
        return r;
    };
    // A directly accepted computer. `introducer`: false is the 0.2.5 pair; the 0.2.6 pair has the flag on.
    w.pair = (id = PEER, {shared = true, name = 'other computer', introducer = false} = {}) => {
        w.devices.set(id, {name, introducer, autoAcceptFolders: false, introducedBy: ''});
        if (shared)
            w.folders.get('cetli-notes').devices.push({id, introducedBy: ''});
    };
    // A computer the daemon added by introduction: the introducer's name, the introducer's flag copied, `introducedBy` set on the device
    // and on its share (PLAN-ADMISSION 1.2, measured in 211).
    w.introduce = (id, by, {name = 'introduced', introducer = true, shared = true} = {}) => {
        w.devices.set(id, {name, introducer, autoAcceptFolders: false, introducedBy: by});
        if (shared)
            w.folders.get('cetli-notes').devices.push({id, introducedBy: by});
    };
    // N more computers in the group: the first `direct` accepted here, the rest introduced by the first. Returns the IDs.
    w.group = (ids, {direct = 1, introducer = true, shared = true} = {}) => {
        ids.forEach((id, i) => (i < direct ? w.pair(id, {introducer, shared, name: `pc-${i}`}) : w.introduce(id, ids[0], {name: `pc-${i}`, introducer, shared})));
        return ids;
    };
    w.configXml = configXml;
    return w;
}

// An ISO time with the second resolution of Syncthing's pending list.
export const isoOf = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
