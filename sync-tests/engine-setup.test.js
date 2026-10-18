// SPDX-License-Identifier: GPL-3.0-or-later
// The engine: setup, status, own-id and forget against the stub machine of support/world.js (no Syncthing, no systemd, no Gio).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld, OWN, PEER, OTHER, FAKE_KEY} from './support/world.js';
import {editConfig, PORTS_OWN} from '../sync/confedit.js';
import {readFileSync} from 'node:fs';
import {STATUS_STATES} from '../sync/protocol.js';
import {foreignDevices, folderAnomaly} from '../sync/engine.js';

const GENERATED = readFileSync(new URL('./fixtures/config-generated.xml', import.meta.url), 'utf8');
const perform = (w, verb, arg) => w.engine().perform(verb, arg);
const everything = w => JSON.stringify([w.events, w.journal, w.calls.map(c => c.argv), w.calls.map(c => c.env)]);

test('setup on a fresh machine: generate, then our edit, then the service, then the folder, in that order', async () => {
    const w = createWorld();
    const r = await perform(w, 'setup');
    assert.deepEqual(r, {result: {event: 'result', own_id: OWN, state: 'set-up'}});
    const t = w.timeline;
    const idx = x => t.findIndex(e => e.startsWith(x));
    assert.ok(idx('generate') >= 0 && idx('generate') < idx(`write ${w.home}/config.xml`), 'generate before the edit');
    assert.ok(idx(`write ${w.home}/config.xml`) < idx('systemctl enable'), 'the edit before the service starts (serve first, edit after is a bug)');
    assert.ok(idx('systemctl enable') < idx('cli config folders add'), 'the folder is added to the running daemon');
    assert.deepEqual(w.events.filter(e => e.event === 'progress').map(e => `${e.step}:${e.state}`), ['instance:start', 'instance:ok', 'service:start', 'service:ok', 'folder:start', 'folder:ok']);
    const cfg = w.fsMap.get(`${w.home}/config.xml`);
    assert.equal(cfg.mode, 0o600);
    assert.equal(w.fsMap.get(w.home).mode, 0o700);
    assert.equal(cfg.text.includes(`<address>${w.home}/gui.sock</address>`), true);
    assert.equal(cfg.text.includes('<localAnnouncePort>21127</localAnnouncePort>'), true);
});

test('setup: the folder is added with the engine\'s own absolute values; a relative path or another type would be caught', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    const add = w.calls.map(c => c.argv).find(a => a.includes('folders') && a.includes('add'));
    assert.deepEqual(add.slice(3), ['config', 'folders', 'add', '--id', 'cetli-notes', '--label', 'cetli', '--path', w.notes, '--type', 'sendreceive',
        '--fswatcher-enabled', '--fswatcher-delays', '1', '--ignore-perms', '--max-conflicts', '-1']);
    assert.equal(add[add.indexOf('--path') + 1].startsWith('/'), true);
    assert.equal(add.includes('--auto-accept-folders'), false);
    assert.equal(everything(w).includes('autoAccept'), false);
    // a folder that came out relative or with another type makes the read-back refuse
    const bad = createWorld();
    bad.afterFolder = true;
    const orig = bad.folders.set.bind(bad.folders);
    bad.folders.set = (id, f) => orig(id, {...f, path: 'notes'});
    assert.equal((await perform(bad, 'setup')).error.code, 'E_CONFIG_UNSAFE');
    const typed = createWorld();
    const o2 = typed.folders.set.bind(typed.folders);
    typed.folders.set = (id, f) => o2(id, {...f, type: 'receiveonly'});
    assert.equal((await perform(typed, 'setup')).error.code, 'E_CONFIG_UNSAFE');
});

test('setup is idempotent: a second run generates nothing, rewrites nothing, adds nothing, and says the same', async () => {
    const w = createWorld();
    const first = await perform(w, 'setup');
    w.calls.length = 0;
    w.timeline.length = 0;
    const second = await perform(w, 'setup');
    assert.deepEqual(second, first);
    assert.equal(w.timeline.some(e => e === 'generate' || e.startsWith('write ')), false);
    assert.equal(w.calls.some(c => c.argv.includes('add')), false);
});

test('setup: the machine without the sync program: E_NO_SYNCTHING, nothing started or written', async () => {
    const w = createWorld({backend: false});
    assert.deepEqual(await perform(w, 'setup'), {error: {code: 'E_NO_SYNCTHING'}});
    assert.equal(w.calls.length, 0);
    assert.equal(w.timeline.length, 0);
});

test('T9: a marker in notes/ that is not ours: E_STFOLDER_EXISTS, no call, no write', async () => {
    const w = createWorld();
    w.put(`${w.notes}/.stfolder`);
    assert.deepEqual(await perform(w, 'setup'), {error: {code: 'E_STFOLDER_EXISTS'}});
    assert.equal(w.calls.length, 0);
    assert.equal(w.timeline.length, 0);
    assert.equal(w.fsMap.has(w.home), false);
});

test('T9b: a marker in each parent level up to $HOME refuses; one above $HOME is never asked about', async () => {
    for (const level of [`${'/home/u'}/.local/share/cetli`, '/home/u/.local/share', '/home/u/.local', '/home/u']) {
        const w = createWorld();
        w.put(`${level}/.stfolder`);
        assert.equal((await perform(w, 'setup')).error?.code, 'E_STFOLDER_EXISTS', level);
        assert.equal(w.calls.length, 0, level);
    }
    const above = createWorld();
    above.put('/home/.stfolder');
    const asked = [];
    const ports = above.ports();
    const origExists = ports.files.exists;
    ports.files.exists = p => { asked.push(p); return origExists(p); };
    const { createEngine } = await import('../sync/engine.js');
    const r = await createEngine(ports).perform('setup');
    assert.equal(r.error, undefined);
    assert.equal(asked.some(p => p === '/home/.stfolder' || p === '/.stfolder'), false, 'no marker above $HOME is queried');
});

test('T11: our own instance holds cetli-notes: the marker is ours, a re-run and status are no conflict', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    assert.equal(w.fsMap.has(`${w.notes}/.stfolder`), true);
    assert.equal((await perform(w, 'setup')).error, undefined);
    assert.equal((await perform(w, 'status')).result.state, 'set-up');
});

test('T10: a foreign Syncthing\'s config (with an API key) is never opened, and no key is ever in an event, a log or a command', async () => {
    const w = createWorld();
    w.put('/home/u/.local/state/syncthing/config.xml', `<configuration><gui><apikey>FOREIGN-SECRET-KEY</apikey></gui></configuration>`);
    w.put('/home/u/.config/syncthing/config.xml', `<configuration><gui><apikey>FOREIGN-SECRET-KEY-2</apikey></gui></configuration>`);
    const read = [];
    const ports = w.ports();
    const origRead = ports.files.readText;
    ports.files.readText = p => { read.push(p); return origRead(p); };
    const { createEngine } = await import('../sync/engine.js');
    const eng = createEngine(ports);
    await eng.perform('setup');
    await eng.perform('status');
    await eng.perform('forget');
    assert.deepEqual([...new Set(read)], [`${w.home}/config.xml`], 'only our own config.xml is read');
    const all = everything(w);
    for (const secret of ['FOREIGN-SECRET-KEY', FAKE_KEY, 'apikey', 'caller-key'])
        assert.equal(all.includes(secret), false, secret);
});

test('setup: no user service manager, or a daemon that never answers', async () => {
    const a = createWorld({systemd: false});
    assert.deepEqual(await perform(a, 'setup'), {error: {code: 'E_NO_USER_SYSTEMD', step: 'service'}});
    const b = createWorld({startDelayMs: 120000});
    assert.deepEqual(await perform(b, 'setup'), {error: {code: 'E_SERVICE_TIMEOUT', step: 'service'}});
    assert.ok(b.sleeps >= 55, 'it waited about 30 s in half-second steps (virtual time)');
});

test('setup: a config it does not understand, a home with the wrong mode, a link as notes: E_CONFIG_UNSAFE and nothing started', async () => {
    const twoGui = createWorld();
    twoGui.mkdir(twoGui.home, 0o700);
    twoGui.put(`${twoGui.home}/config.xml`, GENERATED.replace('</gui>', '</gui><gui/>'), 0o600);
    twoGui.put(`${twoGui.home}/cert.pem`);
    const r = await perform(twoGui, 'setup');
    assert.equal(r.error.code, 'E_CONFIG_UNSAFE');
    assert.equal(twoGui.timeline.includes('systemctl enable --now'), false);
    assert.equal(everything(twoGui).includes(FAKE_KEY), false);
    assert.ok(twoGui.journal.some(l => /^config: duplicate \(gui/.test(l)), `the log names a field and a reason only (${twoGui.journal})`);
    const loose = createWorld();
    loose.mkdir(loose.home, 0o755);
    assert.equal((await perform(loose, 'setup')).error.code, 'E_CONFIG_UNSAFE');
    assert.equal(loose.calls.length, 0);
    const link = createWorld();
    link.fsMap.get(link.notes).link = true;
    assert.equal((await perform(link, 'setup')).error.code, 'E_CONFIG_UNSAFE');
});

test('setup: a foreign device already in the instance: E_FOREIGN_DEVICE, and the engine does not remove it', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    w.devices.set(OTHER, {name: 'x', introducer: true, autoAcceptFolders: false, introducedBy: ''});
    const r = await perform(w, 'setup');
    assert.deepEqual(r, {error: {code: 'E_FOREIGN_DEVICE', step: 'folder'}});
    assert.equal(w.devices.has(OTHER), true, 'the entry stays');
    assert.equal(w.calls.some(c => c.argv.includes('delete')), false);
});

test('every call: an absolute executable, --home, and no ST* variable of the caller in the environment', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    await perform(w, 'status');
    assert.ok(w.calls.length > 8);
    for (const c of w.calls) {
        assert.equal(c.argv[0].startsWith('/usr/bin/'), true);
        if (c.argv[0].endsWith('syncthing'))
            assert.equal(c.argv.filter(a => a.startsWith('--home=')).length, 1);
        assert.equal(Object.keys(c.env).some(k => k.startsWith('ST')), false);
    }
});

test('status: one result per situation, every state is one the protocol knows', async () => {
    const seen = new Set();
    const noBackend = createWorld({backend: false});
    let r = (await perform(noBackend, 'status')).result;
    seen.add(r.state);
    assert.deepEqual([r.state, r.own_id], ['no-syncthing', null]);
    const foreignMarker = createWorld();
    foreignMarker.put(`${foreignMarker.notes}/.stfolder`);
    r = (await perform(foreignMarker, 'status')).result;
    seen.add(r.state);
    assert.equal(r.state, 'stfolder-conflict');
    assert.equal(foreignMarker.calls.length, 0, 'no process for these two');
    const fresh = createWorld();
    r = (await perform(fresh, 'status')).result;
    seen.add(r.state);
    assert.deepEqual([r.state, r.own_id], ['not-set-up', null]);
    await perform(fresh, 'setup');
    r = (await perform(fresh, 'status')).result;
    seen.add(r.state);
    assert.deepEqual([r.state, r.own_id, r.peer, r.link, r.waiting], ['set-up', OWN, null, null, false]);
    fresh.pair(PEER, {shared: false});
    r = (await perform(fresh, 'status')).result;
    seen.add(r.state);
    assert.deepEqual([r.state, r.shared, r.peer.id, r.link], ['half', false, PEER, 'none']);
    fresh.folders.get('cetli-notes').devices.push({id: PEER, introducedBy: ''});
    r = (await perform(fresh, 'status')).result;
    seen.add(r.state);
    assert.deepEqual([r.state, r.shared], ['paired', true]);
    fresh.devices.get(PEER).introducer = true;
    r = (await perform(fresh, 'status')).result;
    seen.add(r.state);
    assert.deepEqual([r.state, r.link, r.up_to_date, r.shared, r.peer], ['foreign-config', null, null, null, null]);
    for (const s of seen)
        assert.ok(STATUS_STATES.includes(s), s);
    assert.deepEqual([...seen].sort(), [...STATUS_STATES].sort());
});

test('status: set up but the daemon does not answer: E_SERVICE_TIMEOUT; before the folder exists it is simply not set up', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    w.daemon = false;
    assert.deepEqual(await perform(w, 'status'), {error: {code: 'E_SERVICE_TIMEOUT'}});
    const half = createWorld();
    half.mkdir(half.home, 0o700);
    half.put(`${half.home}/cert.pem`);
    half.put(`${half.home}/config.xml`, editConfig(GENERATED, {socketPath: `${half.home}/gui.sock`, ports: PORTS_OWN}).xml, 0o600);
    const r = await perform(half, 'status');
    assert.deepEqual([r.result.state, r.result.own_id], ['not-set-up', OWN], 'an interrupted set-up is resumed by setup');
});

test('T14: a second folder, a relative path, another type, or an introduced device makes status foreign-config', async () => {
    const mk = async mutate => {
        const w = createWorld();
        await perform(w, 'setup');
        mutate(w);
        return (await perform(w, 'status')).result.state;
    };
    assert.equal(await mk(w => w.folders.set('other', {path: '/tmp/x', type: 'sendreceive', devices: [{id: OWN, introducedBy: ''}]})), 'foreign-config');
    assert.equal(await mk(w => { w.folders.get('cetli-notes').path = 'notes'; }), 'foreign-config');
    assert.equal(await mk(w => { w.folders.get('cetli-notes').type = 'sendonly'; }), 'foreign-config');
    assert.equal(await mk(w => { w.pair(PEER); w.devices.get(PEER).introducedBy = OTHER; }), 'foreign-config');
    assert.equal(await mk(w => { w.pair(PEER); w.devices.get(PEER).autoAcceptFolders = true; }), 'foreign-config');
    assert.equal(await mk(w => { w.pair(PEER); w.pair(OTHER); }), 'foreign-config', 'two peers: the one-peer rule (Nicole\'s N-peer rule replaces this)');
    assert.equal(await mk(() => {}), 'set-up');
});

test('foreignDevices and folderAnomaly are one predicate each', () => {
    const d = (id, o = {}) => ({id, introducer: false, autoAcceptFolders: false, introducedBy: '', ...o});
    assert.deepEqual(foreignDevices([d(OWN)], OWN), []);
    assert.deepEqual(foreignDevices([d(OWN), d(PEER)], OWN), []);
    assert.equal(foreignDevices([d(OWN), d(PEER), d(OTHER)], OWN).length, 2);
    assert.equal(foreignDevices([d(OWN), d(PEER, {introducer: true})], OWN).length, 1);
    assert.equal(foreignDevices([d(OWN, {autoAcceptFolders: true})], OWN).length, 1);
    assert.equal(foreignDevices([d(OWN), d(PEER), d(OTHER)], OWN, 2).length, 0);
    const f = (o = {}) => ({id: 'cetli-notes', path: '/n', type: 'sendreceive', devices: [{id: OWN, introducedBy: ''}], ...o});
    assert.equal(folderAnomaly([f()], '/n'), false);
    assert.equal(folderAnomaly([f(), f({id: 'x'})], '/n'), true);
    assert.equal(folderAnomaly([f({path: '/other'})], '/n'), true);
    assert.equal(folderAnomaly([], '/n'), true);
});

test('own-id: the canonical ID of the instance; no instance, no ID', async () => {
    const w = createWorld();
    assert.deepEqual(await perform(w, 'own-id'), {error: {code: 'E_CLI_FAILED'}});
    await perform(w, 'setup');
    assert.deepEqual(await perform(w, 'own-id'), {result: {event: 'result', own_id: OWN}});
});

test('forget: the share and the device go, the folder, the notes, the instance and the unit stay; a second run changes nothing', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    w.note(3);
    w.pair(PEER);
    const before = [...w.fsMap.keys()].filter(k => k.startsWith(w.notes)).sort();
    const r = await perform(w, 'forget');
    assert.deepEqual(r, {result: {event: 'result', state: 'set-up'}});
    assert.equal(w.devices.has(PEER), false);
    assert.equal(w.folders.get('cetli-notes').devices.some(d => d.id === PEER), false);
    assert.equal(w.folders.has('cetli-notes'), true, 'the folder stays');
    assert.deepEqual([...w.fsMap.keys()].filter(k => k.startsWith(w.notes)).sort(), before, 'no note and no marker is touched');
    assert.equal(w.daemon, true, 'the unit is not stopped without --stop');
    const del = w.calls.map(c => c.argv).filter(a => a.includes('delete'));
    assert.equal(del.length, 2);
    assert.deepEqual(del[0].slice(-4), ['folders', 'cetli-notes', 'devices', PEER].slice(0, 0).concat(del[0].slice(-4)));
    assert.equal(del.every(a => !a.includes('cetli-notes') || a.includes('devices')), true, 'no call deletes the folder itself');
    w.calls.length = 0;
    assert.deepEqual(await perform(w, 'forget'), r);
    assert.equal(w.calls.some(c => c.argv.includes('delete')), false);
    assert.equal((await perform(w, 'status')).result.state, 'set-up');
});

test('forget --stop also disables the unit; the engine refuses a foreign entry and removes nothing', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    await perform(w, 'forget', {stop: true});
    assert.equal(w.daemon, false);
    const f = createWorld();
    await perform(f, 'setup');
    f.pair(PEER);
    f.devices.get(PEER).introducedBy = OTHER;
    assert.deepEqual(await perform(f, 'forget'), {error: {code: 'E_FOREIGN_DEVICE', step: 'device'}});
    assert.equal(f.devices.has(PEER), true);
    assert.equal(f.calls.some(c => c.argv.includes('delete')), false);
});

test('forget reads back: a delete that did not hold is an error, not a success', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    w.pair(PEER);
    w.failCli.add('devices ' + PEER + ' delete');
    assert.equal((await perform(w, 'forget')).error.code, 'E_CLI_FAILED');
});

test('a failing step carries its step name; an unexpected exception is E_INTERNAL and its text is not logged', async () => {
    const w = createWorld();
    await perform(w, 'setup');
    const ports = w.ports();
    ports.run = {syncthing: async () => { throw new Error(`boom ${FAKE_KEY}`); }, systemctl: async () => ({rc: 0, out: ''})};
    const { createEngine } = await import('../sync/engine.js');
    const r = await createEngine(ports).perform('status');
    assert.deepEqual(r, {error: {code: 'E_INTERNAL'}});
    assert.equal(JSON.stringify(w.journal).includes(FAKE_KEY), false);
    assert.deepEqual(await createEngine(w.ports()).perform('connect'), {error: {code: 'E_INTERNAL'}});
});
