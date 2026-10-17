// SPDX-License-Identifier: GPL-3.0-or-later
// Maps the GNOME specifiers of the extension to the fakes in stubs/.
const stubs = new URL('./stubs/', import.meta.url);

export async function resolve(specifier, context, next) {
    if (specifier.startsWith('gi://')) {
        const name = specifier.slice('gi://'.length).split('?')[0];
        return {url: new URL(`gi/${name}.mjs`, stubs).href, shortCircuit: true};
    }
    const prefix = 'resource:///org/gnome/shell/';
    if (specifier.startsWith(prefix)) {
        const name = specifier.slice(prefix.length).replace(/\//g, '-');
        return {url: new URL(`shell/${name}`, stubs).href.replace(/\.js$/, '.mjs'), shortCircuit: true};
    }
    return next(specifier, context);
}
