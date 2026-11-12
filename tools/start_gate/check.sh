#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Start gate, stage 2: install the RPM into a clean container and start the program from the
# installed copy. Runs as root in a fresh container of the image under test, which has neither the
# source tree nor the build tools of stage 1.
#   /gate this directory
#   /out  the output of build.sh (read only is enough)
# (rpm) the RPM is installed, (tag) on a run for a tag: the tag is v<version of the RPM>,
# (a) the installed copy has the version of the RPM, (b) its modules import with the typelibs the
# RPM pulled in, (c) a real SIGTERM reaches the signal watch the program installs, in a real GLib
# main loop, (d) the real `cetli` starts in a headless mutter, opens its note window and ends with
# status 0 on SIGTERM, (e) the same for `cetli --autostart` (what the login entry runs), (f) the real
# `cetli-sync status` gives its one closing line. The steps all run; the exit status is 1 if one
# failed. The last line, "START-GATE RESULT ...", is the summary.
set -euo pipefail
. /gate/common.sh

gate_repos
shopt -s nullglob
rpms=(/out/rpm/cetli-*.noarch.rpm)
[ "${#rpms[@]}" -eq 1 ] || { echo "START-GATE RESULT FAIL: expected one RPM in /out/rpm, found ${#rpms[@]}"; exit 1; }
rpm_file=${rpms[0]}
nevra=$(basename "$rpm_file" .rpm)
version=${nevra#cetli-}
version=${version%%-*}
sha=$(sha256sum "$rpm_file" | cut -d' ' -f1)
echo "gate: $nevra sha256 $sha"

# no weak dependencies: the program must start without the optional packages (syncthing). The
# package pulls gnome-shell, and with it the mutter that the start step uses as the display.
gate_dnf install --setopt=install_weak_deps=false "$rpm_file" dbus-daemon
set +e

status=0
# the install is checked with rpm: an image with no rpm cannot pass, the step is not left out
if command -v rpm >/dev/null 2>&1; then
    installed=$(rpm -q --qf '%{NVRA}' cetli)
    if [ "$installed" = "$nevra" ]; then
        echo "START-GATE rpm PASS rpm -q cetli: $installed"
    else
        echo "START-GATE rpm FAIL rpm -q gives $installed, the file is $nevra"
        status=1
    fi
else
    echo "START-GATE rpm FAIL there is no rpm in the image: the install cannot be checked"
    status=1
fi

# a run for a tag (GITHUB_REF_TYPE and GITHUB_REF_NAME come from the runner through start_gate.sh):
# the tag must be v<version of the RPM>, so a tag and a VERSION file that differ do not pass
if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
    if [ "${GITHUB_REF_NAME:-}" = "v$version" ]; then
        echo "START-GATE tag PASS the tag $GITHUB_REF_NAME is v$version"
    else
        echo "START-GATE tag FAIL the tag is ${GITHUB_REF_NAME:-unset}, the RPM has version $version"
        status=1
    fi
fi

gjs -m /gate/probe_installed.mjs "$version" || status=1
bash /gate/probe_start.sh || status=1

if [ "$status" -eq 0 ]; then
    echo "START-GATE RESULT PASS $nevra sha256 $sha"
else
    echo "START-GATE RESULT FAIL $nevra sha256 $sha"
fi
exit "$status"
