// SPDX-License-Identifier: GPL-3.0-or-later
// S-T4 (a): the run port builds the child environment from an allowlist and fixes the argv; a stub dumps what it received.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createRunPort, scrubEnv, FORBIDDEN_FLAGS, SYNCTHING_SUBCOMMANDS} from '../sync/runport.js';
import {dedicatedHome, socketPath, DEDICATED_HOME_REL, BACKEND_EXE, SYSTEMCTL_EXE, UNIT_NAME} from '../sync/paths.js';

const HOME = '/home/u/.local/state/cetli/syncthing';
const CALLER = {
    PATH: '/usr/bin:/bin', HOME: '/home/u', LANG: 'hu_HU.UTF-8', XDG_RUNTIME_DIR: '/run/user/1000', XDG_CONFIG_HOME: '/home/u/.config', XDG_STATE_HOME: '/s',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    STGUIADDRESS: '127.0.0.1:9999', STGUIAPIKEY: 'caller-key', STHOMEDIR: '/home/u/other', STCONFDIR: '/c', STDATADIR: '/d', STNOUPGRADE: '1', STFUTURE: 'x',
    LD_PRELOAD: '/evil.so', SSH_AUTH_SOCK: '/s', LC_ALL: 'C', GJS_DEBUG_OUTPUT: 'x', SYNCTHING_FOO: '1', st_lower: 'x', XDG_: 'bare-prefix', NODE_OPTIONS: 'x',
};
const stub = () => {
    const calls = [];
    return {calls, spawn: async (argv, env, opts) => { calls.push({argv, env, opts}); return {rc: 0, out: 'ok\n'}; }};
};

test('S-T4(a): STGUIADDRESS, STGUIAPIKEY, STHOMEDIR and every other ST* variable of the caller never arrive; only the allowlist does', async () => {
    const s = stub();
    const port = createRunPort({spawn: s.spawn, hostEnv: CALLER, home: HOME});
    await port.syncthing('cli', ['config', 'devices', 'list']);
    const env = s.calls[0].env;
    assert.deepEqual(Object.keys(env).sort(), ['DBUS_SESSION_BUS_ADDRESS', 'HOME', 'LANG', 'PATH', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME']);
    for (const k of Object.keys(CALLER).filter(k => /^ST/.test(k)))
        assert.equal(k in env, false, k);
    assert.equal(JSON.stringify(env).includes('caller-key'), false);
    assert.equal(env.HOME, '/home/u');
});

test('the same environment goes to generate, device-id, cli and systemctl: one choke point', async () => {
    const s = stub();
    const port = createRunPort({spawn: s.spawn, hostEnv: CALLER, home: HOME});
    await port.syncthing('generate');
    await port.syncthing('device-id');
    await port.syncthing('cli', ['show', 'system']);
    await port.systemctl(['--user', 'enable', '--now', UNIT_NAME]);
    assert.equal(s.calls.length, 4);
    for (const c of s.calls)
        assert.deepEqual(c.env, s.calls[0].env);
});

test('the argv: an absolute executable, the subcommand, --home put in by the port, then the caller\'s arguments', async () => {
    const s = stub();
    const port = createRunPort({spawn: s.spawn, hostEnv: CALLER, home: HOME});
    await port.syncthing('cli', ['config', 'folders', 'cetli-notes', 'devices', 'list']);
    await port.syncthing('generate');
    assert.deepEqual(s.calls[0].argv, [BACKEND_EXE, 'cli', `--home=${HOME}`, 'config', 'folders', 'cetli-notes', 'devices', 'list']);
    assert.deepEqual(s.calls[1].argv, [BACKEND_EXE, 'generate', `--home=${HOME}`]);
    assert.equal(BACKEND_EXE, '/usr/bin/syncthing');
    assert.equal(s.calls[0].argv.filter(a => a.startsWith('--home')).length, 1);
});

test('a caller cannot choose another home, a GUI address, an API key, or a subcommand outside the closed list', () => {
    const port = createRunPort({spawn: stub().spawn, hostEnv: CALLER, home: HOME});
    for (const flag of ['--home=/other', '--home', '--gui-address=127.0.0.1:1', '--gui-apikey=k', '--gui-apikey', '--config=/x', '--data=/x', '--db-dir=/x'])
        assert.throws(() => port.syncthing('cli', ['config', flag]), /set by the port only/, flag);
    for (const sub of ['serve', 'paths', 'debug', '--version', 'cli --home=/x', '', 5, undefined])
        assert.throws(() => port.syncthing(sub), /not allowed/, String(sub));
    assert.throws(() => port.syncthing('cli', 'config'), /not allowed/);
    assert.throws(() => port.syncthing('cli', ['a\0b']), /not allowed/);
    assert.throws(() => port.syncthing('cli', [5]), /not allowed/);
    assert.deepEqual([...SYNCTHING_SUBCOMMANDS], ['cli', 'generate', 'device-id']);
    assert.equal(FORBIDDEN_FLAGS.test('--homedir'), false);          // only the exact flags
});

test('short and one-dash spellings of the forbidden flags are refused too; a negative number is not a flag (-1 of --max-conflicts)', async () => {
    const s = stub();
    const port = createRunPort({spawn: s.spawn, hostEnv: CALLER, home: HOME});
    for (const flag of ['-H', '-Hx', '-H/x', '-C', '-D', '-hH', '-h', '-home=/evil', '-gui-address=x', '-config=/x', '--conf', '--conf=/x', '--home=a', '-a'])
        assert.throws(() => port.syncthing('generate', [flag]), /set by the port only/, flag);
    assert.throws(() => port.syncthing('cli', ['config', 'x', '-H', 'b']), /set by the port only/);
    await port.syncthing('cli', ['config', 'folders', 'f', 'add', '--max-conflicts', '-1']);
    assert.deepEqual(s.calls[0].argv.slice(-2), ['--max-conflicts', '-1']);
    // the one --home the child gets is the port's, whatever the caller passed
    for (const c of s.calls)
        assert.equal(c.argv.filter(a => /^-/.test(a) && /home/.test(a)).length, 1);
});

test('systemctl: only the closed calls on our own unit', async () => {
    const s = stub();
    const port = createRunPort({spawn: s.spawn, hostEnv: CALLER, home: HOME});
    for (const ok of [['--user', 'enable', '--now', UNIT_NAME], ['--user', 'disable', '--now', UNIT_NAME], ['--user', 'disable', UNIT_NAME], ['--user', 'stop', UNIT_NAME], ['--user', 'is-active', UNIT_NAME]])
        await port.systemctl(ok);
    assert.equal(s.calls[0].argv[0], SYSTEMCTL_EXE);
    const sneaky = {toJSON: () => '--user'};                     // an object that serialises like an allowed argument
    assert.throws(() => port.systemctl([sneaky, 'stop', UNIT_NAME]), /not allowed/);
    for (const bad of [[], ['--user', 'enable', '--now', 'syncthing.service'], ['enable', '--now', UNIT_NAME], ['--user', 'enable', '--now', UNIT_NAME, 'other.service'],
        ['--system', 'enable', '--now', UNIT_NAME], ['--user', 'mask', UNIT_NAME], ['--user', 'daemon-reload'], ['--user', 'start', 'x;y'], 'enable'])
        assert.throws(() => port.systemctl(bad), /not allowed/, JSON.stringify(bad));
});

test('the output cap: an output over maxBytes (or flagged tooLarge) is dropped and reported', async () => {
    const big = {spawn: async () => ({rc: 0, out: 'x'.repeat(2000)})};
    const port = createRunPort({spawn: big.spawn, hostEnv: CALLER, home: HOME});
    assert.deepEqual(await port.syncthing('cli', ['show', 'pending', 'devices'], {maxBytes: 1000}), {rc: 0, out: '', tooLarge: true});
    assert.deepEqual(await createRunPort({spawn: async () => ({rc: 0, out: 'é'.repeat(600)}), hostEnv: {}, home: HOME}).syncthing('cli', [], {maxBytes: 1000}), {rc: 0, out: '', tooLarge: true});
    assert.deepEqual(await createRunPort({spawn: async () => ({rc: 0, out: 'a', tooLarge: true}), hostEnv: {}, home: HOME}).syncthing('cli', []), {rc: 0, out: '', tooLarge: true});
    assert.deepEqual(await createRunPort({spawn: async () => ({rc: 3, out: 'err'}), hostEnv: {}, home: HOME}).syncthing('cli', []), {rc: 3, out: 'err'});
    // no exit code (a timeout, no result) is a failure, not a size problem
    assert.deepEqual(await createRunPort({spawn: async () => null, hostEnv: {}, home: HOME}).syncthing('cli', []), {rc: -1, out: '', failed: true});
    assert.deepEqual(await createRunPort({spawn: async () => ({rc: -1, out: 'x'}), hostEnv: {}, home: HOME}).syncthing('cli', []), {rc: -1, out: 'x'});
    assert.deepEqual(await createRunPort({spawn: async () => ({rc: 0.5, out: 'x'}), hostEnv: {}, home: HOME}).syncthing('cli', []), {rc: -1, out: '', failed: true});
});

test('the opts reach the spawn: stdin, maxBytes, timeout; the env object handed over is a copy', async () => {
    const s = stub();
    const port = createRunPort({spawn: s.spawn, hostEnv: CALLER, home: HOME});
    await port.syncthing('cli', ['x'], {stdin: 'in', maxBytes: 2048, timeoutMs: 5000});
    assert.deepEqual(s.calls[0].opts, {stdin: 'in', maxBytes: 2048, timeoutMs: 5000});
    s.calls[0].env.PATH = 'tampered';
    assert.equal(port.env().PATH, '/usr/bin:/bin');
    await port.syncthing('cli', ['y']);
    assert.deepEqual(s.calls[1].opts, {stdin: null, maxBytes: 1024 * 1024, timeoutMs: 30000});
});

test('scrubEnv: a bare XDG_, non-string values and NUL values are dropped; nothing is added', () => {
    assert.deepEqual(scrubEnv({HOME: '/h', XDG_: 'x', PATH: 5, LANG: 'a\0b', XDG_DATA_HOME: '/d'}), {HOME: '/h', XDG_DATA_HOME: '/d'});
    assert.deepEqual(scrubEnv(null), {});
    assert.deepEqual(scrubEnv({}), {});
});

test('the port is the only file under sync/ that names the syncthing or systemctl executable or starts a process', () => {
    const dir = new URL('../sync/', import.meta.url);
    for (const f of readdirSync(dir).filter(n => n.endsWith('.js'))) {
        const text = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const names = /\/usr\/bin\/(syncthing|systemctl)|\bSubprocess\b|\bspawn\(|child_process/.test(text);
        assert.equal(names, ['paths.js', 'runport.js', 'gio-ports.js'].includes(f) ? names : false, `${f} must not start a process`);
        if (f !== 'runport.js')
            assert.equal(/STGUI|STHOME|apikey|api_key|getenv/i.test(text), false, `${f} touches an ST* or key name`);
        if (!['runport.js', 'gio-ports.js'].includes(f))
            assert.equal(/environ\b/i.test(text), false, `${f} builds or applies an environment`);       // gio-ports.js only applies the scrubbed one
    }
});

test('paths: the dedicated home is fixed under the user\'s home; the drift test of the unit comes with the spec step', () => {
    assert.equal(DEDICATED_HOME_REL, '.local/state/cetli/syncthing');
    assert.equal(dedicatedHome('/home/u'), '/home/u/.local/state/cetli/syncthing');
    assert.equal(socketPath(dedicatedHome('/home/u')), '/home/u/.local/state/cetli/syncthing/gui.sock');
    for (const bad of ['home/u', '', null, '/home//u', '/home/u/', '/h\nx'])
        assert.throws(() => dedicatedHome(bad), RangeError, String(bad));
});
