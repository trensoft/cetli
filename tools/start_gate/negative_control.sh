#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# The negative control of the start gate: on a copy of the tree with a start-up error in it, the gate must FAIL.
# A gate that cannot fail on a bad tree is not a gate.
# usage: tools/start_gate/negative_control.sh IMAGE TREE
#   IMAGE  the image of a leg: quay.io/centos/centos:stream10 (epel-10)
#   TREE   a git checkout of cetli (the tree under test); it is copied, it is not changed
# The error is the kind that slideshow-lock 1.0.11 went out with: the program calls a function that is not
# there on the platform, in the setup of its main loop, so the imports and the typelibs are fine and only the
# start fails. In the copy, app/application.js calls GLibUnix.signal_add for the SIGTERM watch, and GLibUnix is
# not imported (a ReferenceError the moment createApp() runs, on every chroot). The copy is committed (the
# source RPM is made from HEAD), then start_gate.sh runs on it.
# Exit status 0 only when the gate built the RPM and then failed in step (d), the real start, FOR THE REASON that
# was put in, while the steps before it passed. Each is a line of its own in the output of stage 2:
# "START-GATE RESULT FAIL", "START-GATE d FAIL" with the "ReferenceError: GLibUnix is not defined" of the copy in
# the log of the program that the probe prints under it, and a PASS of (rpm), (a), (b) and (c). A gate that passes
# is soft (exit 1). A gate that stopped before stage 2, or failed for another reason (no network, a build error, a
# failure of (rpm), (a), (b) or (c), a (d) that fails with another message), proves nothing and is not a pass
# either (exit 1).
set -uo pipefail

image=${1:?usage: negative_control.sh IMAGE TREE}
tree=${2:?usage: negative_control.sh IMAGE TREE}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
log=$work/gate.log
trap 'rm -rf "$work"' EXIT

cp -a "$tree" "$work/tree" || { echo "NEGATIVE-CONTROL FAIL: $tree could not be copied"; exit 1; }
target=$work/tree/app/application.js
[ "$(grep -c 'GLib\.unix_signal_add(GLib\.PRIORITY_DEFAULT, 15,' "$target" 2>/dev/null)" = 1 ] \
    || { echo "NEGATIVE-CONTROL FAIL: the SIGTERM watch is not in app/application.js once, the error cannot be put in"; exit 1; }
sed -i 's/GLib\.unix_signal_add(GLib\.PRIORITY_DEFAULT, 15,/GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15,/' "$target"
grep -q 'GLibUnix\.signal_add(GLib\.PRIORITY_DEFAULT, 15,' "$target" \
    || { echo "NEGATIVE-CONTROL FAIL: the error was not put in"; exit 1; }
git -C "$work/tree" -c user.name=start-gate -c user.email=start-gate@invalid -c commit.gpgsign=false \
    commit --quiet --all --message "negative control: GLibUnix.signal_add is called and not imported" \
    || { echo "NEGATIVE-CONTROL FAIL: the copy could not be committed"; exit 1; }

bash "$here/start_gate.sh" "$image" "$work/tree" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}

if [ "$rc" -eq 0 ]; then
    echo "NEGATIVE-CONTROL FAIL: the gate PASSED on a tree that cannot start; it is soft"
    exit 1
fi
# Only the output of stage 2 counts, from the line start_gate.sh prints before it: a line of the build in stage 1 that has the same words is
# not a step of the probe. Every line is matched at its start and in its own case, so a line that only quotes a line of the probe does not count.
stage2=$(awk '/^== stage 2: / {inside = 1} inside' "$log")
# The reason is looked at too: a (d) that fails for another reason (a start that breaks for a reason of the image, a probe that has a fault of
# its own) is not the error that was put in. The log of the program, which the probe prints right after the FAIL line of the step, must hold
# the ReferenceError of the copy, and no other step's block counts.
d_block=$(awk '/^START-GATE d FAIL/ {inside = 1; next} /^START-GATE / {inside = 0} inside' <<<"$stage2")
if ! grep -q '^START-GATE RESULT FAIL' <<<"$stage2" || ! grep -q '^START-GATE d FAIL' <<<"$stage2" \
    || ! grep -q '^START-GATE rpm PASS' <<<"$stage2" \
    || ! grep -q '^START-GATE a PASS' <<<"$stage2" || ! grep -q '^START-GATE b PASS' <<<"$stage2" || ! grep -q '^START-GATE c PASS' <<<"$stage2"; then
    echo "NEGATIVE-CONTROL FAIL: the gate failed (status $rc) but not in step (d) alone in stage 2:" \
        "it proves nothing"
    exit 1
fi
if ! grep -q 'ReferenceError: GLibUnix is not defined' <<<"$d_block"; then
    echo "NEGATIVE-CONTROL FAIL: step (d) failed, but the log of the program does not show the error that was put in" \
        "(ReferenceError: GLibUnix is not defined): it failed for another reason and proves nothing"
    exit 1
fi
echo "NEGATIVE-CONTROL PASS: the gate failed in step (d), the real start, with the ReferenceError of the copy, and (rpm), (a), (b) and (c) passed, as they must"
exit 0
