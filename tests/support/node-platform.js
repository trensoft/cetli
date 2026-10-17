// SPDX-License-Identifier: GPL-3.0-or-later
import crypto from 'node:crypto';

export const T0 = Date.parse('2026-10-17T12:00:00.000Z');

export const sha256Hex = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const sha1 = bytes => new Uint8Array(crypto.createHash('sha1').update(bytes).digest());

// A controllable clock and deterministic "random" values, so that the tests are repeatable.
export function nodePlatform({start = T0} = {}) {
    const clock = {t: start};
    let n = 0;
    const lines = [];
    const platform = {
        sha256Hex, sha1,
        now: () => clock.t,
        randomUuid: () => {
            n++;
            return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
        },
        randomBytes: len => Uint8Array.from({length: len}, (_, i) => (0x5a + i * 7 + n) & 0xff),
        log: {warn: m => lines.push(`WARN ${m}`), info: m => lines.push(`INFO ${m}`)},
    };
    return {platform, clock, lines};
}
