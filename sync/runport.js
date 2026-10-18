// SPDX-License-Identifier: GPL-3.0-or-later
// The ONE place that starts `syncthing` and `systemctl` for the engine (PLAN-WIZARD 0E, 6.2, S-1, S-2; PLAN-WIZARD-INTERFACE 2). The low-level
// start (`spawn(argv, env, opts) -> Promise<{rc, out}>`) is injected: Gio.Subprocess in the real program (sync/main.js), a stub in the
// tests. Everything that makes a call safe is here, so a stub test (S-T4 (a)) pins it:
//   - the child environment is built from an ALLOWLIST (PATH, HOME, XDG_*, LANG, DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR); every
//     `ST*` variable is dropped, and so is everything else, whatever its name. M-W3 measured that the GUI address and GUI key variables redirect
//     `syncthing cli --home=X` AND its writes to another instance. No call site builds its own environment.
//   - the executable is an absolute literal, the arguments are an array (no shell), and `--home=<dedicated home>` is put in by the port;
//     a caller cannot pass a home, a GUI address or an API key flag, in any spelling: the long forms, the one-dash forms and every short
//     flag are refused (flags are not a defence, 0E row 8; there is no key, S-2). So the last-wins rule of the flag parser has no
//     second `--home` to prefer.
//   - systemctl is reachable only for the closed list of calls on our own unit.
import {BACKEND_EXE, SYSTEMCTL_EXE, UNIT_NAME} from './paths.js';

const ENV_NAMES = Object.freeze(['PATH', 'HOME', 'LANG', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']);
const ENV_PREFIXES = Object.freeze(['XDG_']);

export const SYNCTHING_SUBCOMMANDS = Object.freeze(['cli', 'generate', 'device-id']);
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30000;
// `-1` (the value of --max-conflicts) is not refused: a short flag starts with a letter.
export const FORBIDDEN_FLAGS = /^(--(home|config|data|conf|db-dir|gui-address|gui-apikey)(=|$)|-[A-Za-z])/;

// The environment of a child: the allowlisted variables of `hostEnv` (a plain object), values as they are (a value with a NUL is dropped).
export function scrubEnv(hostEnv) {
    const out = {};
    for (const [k, v] of Object.entries(hostEnv ?? {})) {
        const allowed = ENV_NAMES.includes(k) || ENV_PREFIXES.some(p => k.startsWith(p) && k.length > p.length);
        if (allowed && typeof v === 'string' && !v.includes('\0'))
            out[k] = v;
    }
    return out;
}

const SYSTEMCTL_CALLS = Object.freeze([
    ['--user', 'enable', '--now', UNIT_NAME],
    ['--user', 'disable', '--now', UNIT_NAME],
    ['--user', 'disable', UNIT_NAME],
    ['--user', 'stop', UNIT_NAME],
    ['--user', 'is-active', UNIT_NAME],
].map(a => JSON.stringify(a)));

const okArg = a => typeof a === 'string' && !a.includes('\0');

// `spawn`: injected. `hostEnv`: the caller's environment (a snapshot object). `home`: the dedicated home (paths.dedicatedHome).
export function createRunPort({spawn, hostEnv, home}) {
    if (typeof spawn !== 'function' || typeof home !== 'string' || !home.startsWith('/'))
        throw new TypeError('createRunPort: spawn and an absolute home are required');
    const env = Object.freeze(scrubEnv(hostEnv));
    const start = async (argv, {stdin = null, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) => {
        const r = await spawn(argv, {...env}, {stdin, maxBytes, timeoutMs});
        const out = typeof r?.out === 'string' ? r.out : '';
        if (!Number.isInteger(r?.rc))
            return {rc: -1, out: '', failed: true};                  // no exit code (timeout, no result): not a size problem
        if (new TextEncoder().encode(out).length > maxBytes || r.tooLarge === true)
            return {rc: r.rc, out: '', tooLarge: true};
        return {rc: r.rc, out};
    };
    return Object.freeze({
        // run('cli', ['config', 'devices', 'list']) -> {rc, out}. Does not throw for a failing child (rc, `failed`, `tooLarge`): the engine reads
        // them and shows a code. A refused call (TypeError) and a spawn that cannot start the executable (the injected spawn rejects) do throw.
        syncthing(sub, args = [], opts = {}) {
            if (!SYNCTHING_SUBCOMMANDS.includes(sub) || !Array.isArray(args) || !args.every(okArg))
                throw new TypeError('syncthing: subcommand or arguments not allowed');
            if (args.some(a => FORBIDDEN_FLAGS.test(a)))
                throw new TypeError('syncthing: this flag is set by the port only');
            return start([BACKEND_EXE, sub, `--home=${home}`, ...args], opts);
        },
        systemctl(args, opts = {}) {
            if (!Array.isArray(args) || !args.every(a => typeof a === 'string') || !SYSTEMCTL_CALLS.includes(JSON.stringify(args)))
                throw new TypeError('systemctl: call not allowed');
            return start([SYSTEMCTL_EXE, ...args], opts);
        },
        // for the tests: what a child would receive
        env: () => ({...env}),
    });
}
