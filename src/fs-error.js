// SPDX-License-Identifier: GPL-3.0-or-later

// Error of the file layer. `code` is one of the values below; every layer (Gio, Node test layer, fakes) maps its
// own errors to these so that the core never looks at a platform error type.
export const FS = Object.freeze({
    NOT_FOUND: 'NOT_FOUND',
    EXISTS: 'EXISTS',
    NOT_SUPPORTED: 'NOT_SUPPORTED', // G_IO_ERROR_NOT_SUPPORTED, also EXDEV with NO_FALLBACK_FOR_MOVE
    NO_SPACE: 'NO_SPACE',
    IO: 'IO',
});

export class FsError extends Error {
    constructor(code, message) {
        super(message ?? code);
        this.name = 'FsError';
        this.code = code;
    }
}
