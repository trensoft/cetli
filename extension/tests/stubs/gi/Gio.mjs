// SPDX-License-Identifier: GPL-3.0-or-later
// A fake Gio over the real disk. Every async call finishes in a later microtask, like a GIO callback would.
import fs from 'node:fs';
import path from 'node:path';
import {world} from '../world.mjs';

const FileQueryInfoFlags = {NONE: 0, NOFOLLOW_SYMLINKS: 1};
const IOErrorEnum = {NOT_FOUND: 1, FAILED: 2};
const FileType = {REGULAR: 1, DIRECTORY: 2, SYMBOLIC_LINK: 3, SPECIAL: 4, UNKNOWN: 0};

class GError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }

    matches(_domain, code) {
        return this.code === code;
    }
}

// Runs fn now, delivers its result to the callback later; the finish function returns or throws it.
// With `delay` (ms, real time) the callback comes from a timer, so other work can run in between.
function start(self, cb, fn, delay = 0) {
    let res;
    try {
        res = {v: fn()};
    } catch (e) {
        res = {e};
    }
    if (delay > 0)
        setTimeout(() => cb(self, res), delay);
    else
        queueMicrotask(() => cb(self, res));
}

const finish = res => {
    if (res.e)
        throw res.e;
    return res.v;
};

const fsError = e => (e.code === 'ENOENT' ? new GError(IOErrorEnum.NOT_FOUND, 'not found') : new GError(IOErrorEnum.FAILED, e.message));

class Stream {
    constructor(data) {
        this.data = data;
        this.at = 0;
    }

    read_bytes_async(count, _prio, _cancel, cb) {
        start(this, cb, () => {
            // A short read on purpose: at most 4 KiB per call.
            const chunk = this.data.subarray(this.at, this.at + Math.min(count, (world.chunk || 4096)));
            this.at += chunk.length;
            world.ioCalls.push('read-chunk');
            return {get_size: () => chunk.length, toArray: () => chunk};
        });
    }

    read_bytes_finish = finish;

    close_async(_prio, _cancel, cb) {
        start(this, cb, () => {
            world.openStreams--;
            world.ioCalls.push('close');
            return true;
        });
    }

    close_finish = finish;
}

class File {
    constructor(p) {
        this.p = p;
    }

    static new_for_path(p) {
        return new File(p);
    }

    query_info_async(_attrs, flags, _prio, _cancel, cb) {
        start(this, cb, () => {
            if (world.failRead)
                throw new GError(IOErrorEnum.FAILED, world.failRead);
            let st;
            try {
                // Like GIO: without NOFOLLOW_SYMLINKS a link is followed and the target is described.
                st = flags & FileQueryInfoFlags.NOFOLLOW_SYMLINKS ? fs.lstatSync(this.p) : fs.statSync(this.p);
            } catch (e) {
                throw fsError(e);
            }
            const type = st.isFile() ? FileType.REGULAR : st.isDirectory() ? FileType.DIRECTORY :
                st.isSymbolicLink() ? FileType.SYMBOLIC_LINK : FileType.SPECIAL;
            return {get_file_type: () => type, get_size: () => st.size};
        }, world.ioDelay);
    }

    query_info_finish = finish;

    read_async(_prio, _cancel, cb) {
        start(this, cb, () => {
            world.ioCalls.push('read');
            if (world.growOnRead)
                fs.appendFileSync(this.p, ' '.repeat(world.growOnRead));   // the file grows after the size check
            try {
                const stream = new Stream(fs.readFileSync(this.p));
                world.openStreams++;
                return stream;
            } catch (e) {
                throw fsError(e);
            }
        }, world.ioDelay);
    }

    read_finish = finish;

    // GIO writes a temporary file in the same directory and renames it over the target.
    replace_contents_bytes_async(bytes, etag, backup, flags, _cancel, cb) {
        start(this, cb, () => {
            if (world.failWrite)
                throw new GError(IOErrorEnum.FAILED, 'disk full');
            if (flags !== this.constructor.REPLACE_DESTINATION)
                throw new Error('the write must use REPLACE_DESTINATION');
            // No etag (the file is re-read before every write) and no backup file next to layout.json.
            if (etag !== null)
                throw new Error('the write must not pass an etag');
            if (backup !== false)
                throw new Error('the write must not make a backup file');
            const tmp = path.join(path.dirname(this.p), `.${path.basename(this.p)}.tmp`);
            fs.writeFileSync(tmp, bytes.toArray());
            fs.renameSync(tmp, this.p);
            world.ioCalls.push('write');
            return [true, ''];
        });
    }

    replace_contents_finish = finish;

    static REPLACE_DESTINATION = 2;
}

export default {
    File,
    IOErrorEnum,
    FileType,
    FileQueryInfoFlags,
    FileCreateFlags: {NONE: 0, REPLACE_DESTINATION: 2},
};
