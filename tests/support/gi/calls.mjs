// SPDX-License-Identifier: GPL-3.0-or-later
// What the adapter asked Gio/GLib to do: [name, ...arguments], in order. The tests read it and set `plan` to steer answers.
export const calls = [];
export const plan = {};
export const reset = () => {
    calls.length = 0;
    for (const k of Object.keys(plan))
        delete plan[k];
};
