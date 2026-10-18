// SPDX-License-Identifier: GPL-3.0-or-later
// PURE: every knob of the group rule in ONE file (PLAN-0.2.6 2.1, PLAN-ADMISSION-0.2.6). The number of computers lives here and nowhere
// else: the engine imports it, the window gets it from `status.max_computers`. The two switches wait for John's measurements; both
// branches are built and tested, the values below are the ones the release uses.

export const MAX_COMPUTERS = 10;
// Devices other than the own one (Nicole T-N1/X1): 10 computers are 9 peers, a literal 10 would allow 11 computers.
export const MAX_PEERS = MAX_COMPUTERS - 1;
// Device-list lines read before `over-limit` is answered without one `dump-json` per device (Nicole 3.5: "16").
export const READ_CAP = MAX_COMPUTERS + 6;

// V-A2: introduced devices get `introducer=false` (the delegation depth stays 1). Needs M-J5; the value is `false` until it is measured.
export const HARDEN_INTRODUCED = false;
// The "retired computer" shortcut `forget <ID>` on a directly accepted device. Needs M-J1; `false` until it is measured.
export const SHORTCUT_REMOVE = false;

// Wait between the first and the second read-back of `revoke`: one reconnect cycle (Nicole [H], M-J3 may change it).
export const DWELL_MS = 15000;

// The flag a peer should carry: a directly accepted device (introducedBy empty) is an introducer, an introduced one is none under V-A2.
// `harden`, `promote`, `finish` and `status.harden_pending` all use this one function (PLAN-0.2.6 F6).
export const wantedIntroducer = (device, hardenIntroduced = HARDEN_INTRODUCED) => device.introducedBy === '' ? true : !hardenIntroduced;
