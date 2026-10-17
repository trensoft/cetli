// SPDX-License-Identifier: GPL-3.0-or-later
// A recording fake of the parts of Gio that src/gio-layer.js uses. The flag values are the real ones of Gio.
import {calls, plan} from './calls.mjs';

const FileType = {UNKNOWN: 0, REGULAR: 1, DIRECTORY: 2, SYMBOLIC_LINK: 3, SPECIAL: 4};
const FileQueryInfoFlags = {NONE: 0, NOFOLLOW_SYMLINKS: 1};
const FileCopyFlags = {NONE: 0, OVERWRITE: 1, BACKUP: 2, NOFOLLOW_SYMLINKS: 4, ALL_METADATA: 8, NO_FALLBACK_FOR_MOVE: 16, TARGET_DEFAULT_PERMS: 32};
const FileMonitorFlags = {NONE: 0, WATCH_MOUNTS: 1, SEND_MOVED: 2, WATCH_HARD_LINKS: 4, WATCH_MOVES: 8};
const FileMonitorEvent = {CHANGED: 0, CHANGES_DONE_HINT: 1, DELETED: 2, CREATED: 3, ATTRIBUTE_CHANGED: 4, PRE_UNMOUNT: 5,
    UNMOUNTED: 6, MOVED: 7, RENAMED: 8, MOVED_IN: 9, MOVED_OUT: 10};
const IOErrorEnum = {NOT_FOUND: 1, EXISTS: 2, NOT_SUPPORTED: 15, NO_SPACE: 21, FAILED: 0};

const info = (name, type = FileType.REGULAR, size = 7) => ({
    get_name: () => name,
    get_file_type: () => type,
    get_size: () => size,
    get_modification_date_time: () => ({to_unix: () => 1_700_000_000, get_microsecond: () => 250}),
});

class Monitor {
    connect(sig, fn) {
        calls.push(['monitor.connect', sig]);
        this.fn = fn;
        return 42;
    }

    disconnect(id) { calls.push(['monitor.disconnect', id]); }

    cancel() { calls.push(['monitor.cancel']); }
}

class File {
    constructor(path) { this.path = path; }

    static new_for_path(path) { return new File(path); }

    async enumerate_children_async(attrs, flags, prio, cancel) {
        calls.push(['enumerate_children_async', this.path, attrs, flags, prio, cancel]);
        let n = 0;
        return {
            async next_files_async(count, p, c) {
                calls.push(['next_files_async', count, p, c]);
                return n++ === 0 ? (plan.listing ?? []) : [];
            },
            async close_async(p, c) { calls.push(['close_async', p, c]); },
        };
    }

    async query_info_async(attrs, flags, prio, cancel) {
        calls.push(['query_info_async', this.path, attrs, flags, prio, cancel]);
        if (plan.queryError)
            throw plan.queryError;
        return info('x');
    }

    async load_contents_async(cancel) {
        calls.push(['load_contents_async', this.path, cancel]);
        return [plan.contents ?? new Uint8Array([1, 2, 3]), 'etag'];
    }

    move(dest, flags, progress, cancel) {
        calls.push(['move', this.path, dest.path, flags, progress, cancel]);
        if (plan.moveError)
            throw plan.moveError;
        return true;
    }

    delete(cancel) { calls.push(['delete', this.path, cancel]); return true; }

    monitor_directory(flags, cancel) {
        calls.push(['monitor_directory', this.path, flags, cancel]);
        return new Monitor();
    }
}

export default {
    _promisify() {},
    File,
    FileEnumerator: {prototype: {}},
    FileType,
    FileQueryInfoFlags,
    FileCopyFlags,
    FileMonitorFlags,
    FileMonitorEvent,
    IOErrorEnum,
};
export {info};
