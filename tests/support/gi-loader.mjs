// SPDX-License-Identifier: GPL-3.0-or-later
// Maps `gi://Gio` and `gi://GLib` to the recording fakes in gi/, so that src/gio-layer.js can run under node.
const stubs = new URL('./gi/', import.meta.url);

export async function resolve(specifier, context, next) {
    if (specifier.startsWith('gi://')) {
        const name = specifier.slice('gi://'.length).split('?')[0];
        return {url: new URL(`${name}.mjs`, stubs).href, shortCircuit: true};
    }
    return next(specifier, context);
}
