// SPDX-License-Identifier: GPL-3.0-or-later
// A recording fake of the parts of GLib that src/gio-layer.js uses. Numbers are the real ones of GLib.
import {calls, plan} from './calls.mjs';

class GError extends Error {
    constructor(domain, code, message) {
        super(message);
        this.domain = domain;
        this.code = code;
    }

    matches(domain, code) {
        return this.domain === domain && this.code === code;
    }
}

export const FileError = {EXIST: 'EXIST', NOENT: 'NOENT', NOSPC: 'NOSPC'};

export default {
    Error: GError,
    FileError,
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    FileSetContentsFlags: {NONE: 0, CONSISTENT: 1, DURABLE: 2, ONLY_EXISTING: 4},
    ChecksumType: {SHA1: 0, SHA256: 2},
    file_set_contents_full(path, bytes, flags, mode) {
        calls.push(['file_set_contents_full', path, bytes, flags, mode]);
        if (plan.setContentsError)
            throw plan.setContentsError;
    },
    mkdir_with_parents(dir, mode) {
        calls.push(['mkdir_with_parents', dir, mode]);
        return plan.mkdirResult ?? 0;
    },
    build_filenamev: parts => parts.join('/'),
    get_user_data_dir: () => '/data',
    get_user_state_dir: () => '/state',
    get_real_time: () => 1_700_000_000_000_000,
    uuid_string_random: () => '00000000-0000-4000-8000-000000000000',
    random_int_range: () => 0,
    timeout_add: (_prio, _ms, _fn) => 1,
    source_remove: () => true,
    Bytes: class {
        constructor(data) { this.data = data; }
    },
    compute_checksum_for_bytes: () => '0'.repeat(64),
    Checksum: class {
        update() {}

        get_string() { return '0'.repeat(40); }
    },
};
