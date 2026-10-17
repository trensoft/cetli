// SPDX-License-Identifier: GPL-3.0-or-later
// Public surface of the core. The Gio/GLib adapter (gio-layer.js) is imported separately by the front end, because
// it is the only module that needs `gi://`.
export * from './constants.js';
export {FS, FsError} from './fs-error.js';
export {makeFormat, entryProblem, parseUpdated, utf8Len, isoOf} from './format.js';
export {Store, createStore} from './store.js';
export {createWatcher} from './watcher.js';
export {parseLayout, serializeLayout} from './layout.js';
export {NOTE_COLOR_IDS, pickNoteColor, randomIndex} from './colors.js';
