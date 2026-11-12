// SPDX-License-Identifier: GPL-3.0-or-later
// Negative control of the tests of the start gate: each mutant breaks ONE line of tools/start_gate/, the workflow or docs/RELEASING.md (the
// kind of change that would make the gate soft), runs the tests that guard that file, and expects them to fail. A mutant that survives is
// a line no test protects. Not part of CI (it needs a few minutes).
//   node app-tests/mutants-rpm-gate.js            all mutants, one at a time, in a copy of the tree
//   node app-tests/mutants-rpm-gate.js C3 P7      only these
// Every file is restored from the copy after each mutant (a mutant that is not applied exactly once is BROKEN, not KILLED).
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = 'tools/start_gate/';
const T = 'app-tests/rpm-gate-';
const FAMILY = {
    [`${G}check.sh`]: ['run'], [`${G}build.sh`]: ['run'], [`${G}start_gate.sh`]: ['run'], [`${G}negative_control.sh`]: ['run'], [`${G}common.sh`]: ['run'],
    [`${G}probe_start.sh`]: ['probe'], [`${G}verify_checks.sh`]: ['verify'], [`${G}probe_installed.mjs`]: ['steps'], [`${G}probe_steps.mjs`]: ['steps'], [`${G}probe_logic.mjs`]: ['logic'],
    '.github/workflows/start-gate.yml': ['workflow'], '.github/workflows/negative-control.yml': ['workflow'], 'docs/RELEASING.md': ['workflow'], 'app/application.js': ['logic'],
};

// [id, file, find, replace]; `find` must be in the file exactly once, unless the id is in MANY (then every occurrence)
const M = [
    // check.sh
    ['C1', 'check.sh', '--setopt=install_weak_deps=false ', ''],
    ['C2', 'check.sh', 'probe_installed.mjs "$version" || status=1', 'probe_installed.mjs "$version"'],
    ['C3', 'check.sh', 'bash /gate/probe_start.sh || status=1', 'bash /gate/probe_start.sh'],
    ['C4', 'check.sh', 'exit "$status"\n', 'exit 0\n'],
    ['C5', 'check.sh', 'rpm -q gives $installed, the file is $nevra"\n        status=1', 'rpm -q gives $installed, the file is $nevra"\n        status=0'],
    ['C6', 'check.sh', 'the install cannot be checked"\n    status=1', 'the install cannot be checked"\n    status=0'],
    ['C7', 'check.sh', 'the RPM has version $version"\n        status=1', 'the RPM has version $version"\n        status=0'],
    ['C8', 'check.sh', '[ "${#rpms[@]}" -eq 1 ]', '[ "${#rpms[@]}" -ge 1 ]'],
    ['C9', 'check.sh', 'version=${version%%-*}\n', '\n'],
    ['C10', 'check.sh', '"v$version" ]', '"$version" ]'],
    ['C11', 'check.sh', '"${GITHUB_REF_TYPE:-}" = "tag"', '"${GITHUB_REF_TYPE:-}" != "tag"'],
    ['C12', 'check.sh', 'dbus-daemon\nset +e', 'dbus-daemon\n'],
    ['C13', 'check.sh', '"$rpm_file" dbus-daemon', '"$rpm_file"'],
    ['C14', 'check.sh', 'if [ "$status" -eq 0 ]; then', 'if [ "$status" -ne 0 ]; then'],
    ['C15', 'check.sh', 'gate_repos\nshopt', 'shopt'],
    // build.sh
    ['B1', 'build.sh', "trap 'chmod -R a+rwX /out' EXIT\n", ''],
    ['B2', 'build.sh', 'gate_dnf builddep "$srpm"\n', ''],
    ['B3', 'build.sh', 'rpmbuild --rebuild --define', 'rpmbuild --rebuild --nodeps --define'],
    ['B4', 'build.sh', 'cp /out/build/RPMS/noarch/cetli-*.noarch.rpm /out/rpm/\n', ''],
    ['B5', 'build.sh', 'set -euo pipefail', 'set -uo pipefail'],
    ['B6', 'build.sh', '"$srpm"\n\ncp', '"$srpm" || true\n\ncp'],
    ['B7', 'build.sh', 'srpm outdir=/out/srpm', 'tarball outdir=/out/srpm'],
    ['B8', 'build.sh', 'gate_dnf install rpm-build git-core gzip make', 'gate_dnf install rpm-build gzip make'],
    ['B9', 'build.sh', 'gate_repos\ngate_dnf', 'gate_dnf'],
    // start_gate.sh
    ['S1', 'start_gate.sh', '-e GITHUB_REF_TYPE -e GITHUB_REF_NAME', ''],
    ['S2', 'start_gate.sh', '-v "$tree":/src:ro', '-v "$tree":/src'],
    ['S3', 'start_gate.sh', '-v "$out":/out:ro', '-v "$out":/out'],
    ['S4', 'start_gate.sh', 'no podman or docker" >&2; exit 2', 'no podman or docker" >&2; exit 0'],
    ['S5', 'start_gate.sh', '[ -e "$tree/.copr/Makefile" ] ||', 'true ||'],
    ['S6', 'start_gate.sh', 'set -euo pipefail', 'set -uo pipefail'],
    ['S7', 'start_gate.sh', '-v "$here":/gate:ro -v "$out":/out:ro', '-v "$tree":/src:ro -v "$here":/gate:ro -v "$out":/out:ro'],
    ['S8', 'start_gate.sh', 'bash /gate/build.sh', 'bash /gate/build.sh || true'],
    // negative_control.sh
    ['N1', 'negative_control.sh', 'it is soft"\n    exit 1', 'it is soft"\n    exit 0'],
    ['N2', 'negative_control.sh', "! grep -q '^START-GATE d FAIL' <<<\"$stage2\"", "! grep -q '^START-GATE c FAIL' <<<\"$stage2\""],
    ['N3', 'negative_control.sh', "    || ! grep -q '^START-GATE rpm PASS' <<<\"$stage2\" \\\n", ''],
    ['N4', 'negative_control.sh', "! grep -q '^START-GATE a PASS' <<<\"$stage2\" || ", ''],
    ['N5', 'negative_control.sh', " || ! grep -q '^START-GATE b PASS' <<<\"$stage2\"", ''],
    ['N5c', 'negative_control.sh', " || ! grep -q '^START-GATE c PASS' <<<\"$stage2\"; then", '; then'],
    ['N6', 'negative_control.sh', "! grep -q '^START-GATE RESULT FAIL' <<<\"$stage2\" || ", ''],
    ['N7', 'negative_control.sh', 'it proves nothing"\n    exit 1\nfi\nif ! grep', 'it proves nothing"\n    exit 0\nfi\nif ! grep'],
    ['N13', 'negative_control.sh', "grep -q 'ReferenceError: GLibUnix is not defined' <<<\"$d_block\"", "grep -q 'ReferenceError: GLibUnix is not defined' \"$log\""],
    ['N14', 'negative_control.sh', '/^START-GATE / {inside = 0} ', ''],
    ['N15', 'negative_control.sh', 'proves nothing"\n    exit 1\nfi\necho "NEGATIVE-CONTROL PASS', 'proves nothing"\n    exit 0\nfi\necho "NEGATIVE-CONTROL PASS'],
    ['N16', 'negative_control.sh', '/^START-GATE d FAIL/ {inside = 1; next}', '/^START-GATE c PASS/ {inside = 1; next}'],
    ['N17', 'negative_control.sh', 'ReferenceError: GLibUnix is not defined\' <<<"$d_block"', 'ReferenceError: GLib is not defined\' <<<"$d_block"'],
    ['N8', 'negative_control.sh', "sed -i 's/GLib", "true 's/GLib"],
    ['N9', 'negative_control.sh', 'target=$work/tree/app/application.js', 'target=$tree/app/application.js'],
    ['N10', 'negative_control.sh', '--all --message', '--message'],
    ['N11', 'negative_control.sh', 'bash "$here/start_gate.sh" "$image" "$work/tree"', 'bash "$here/start_gate.sh" "$image" "$tree"'],
    ['N12', 'negative_control.sh', '"$target" 2>/dev/null)" = 1 ]', '"$target" 2>/dev/null)" = 0 ]'],
    ['N33', 'negative_control.sh', 'git -c advice.detachedHead=false clone --quiet "$tree" "$work/tree"', 'cp -a "$tree" "$work/tree"'],
    ['N34', 'negative_control.sh', 'git -c advice.detachedHead=false clone --quiet "$tree" "$work/tree"', 'git -C "$tree" worktree add --quiet --detach "$work/tree"'],
    // the uncommitted change of the tree gets into the copy anyway
    ['N35', 'negative_control.sh', 'git -c advice.detachedHead=false clone --quiet "$tree" "$work/tree"', 'git -c advice.detachedHead=false clone --quiet "$tree" "$work/tree" && cp "$tree/app/application.js" "$work/tree/app/application.js"'],
    // clones the repository the worktree belongs to (its main checkout), not the worktree
    ['N36', 'negative_control.sh', 'git -c advice.detachedHead=false clone --quiet "$tree" "$work/tree"', 'git clone --quiet "$(git -C "$tree" rev-parse --path-format=absolute --git-common-dir)" "$work/tree"'],
    // only stage 2, every line at its start and in its own case (Petra, review of r2)
    ['N18', 'negative_control.sh', 'stage2=$(awk \'/^== stage 2: / {inside = 1} inside\' "$log")', 'stage2=$(cat "$log")'],
    ['N19', 'negative_control.sh', "awk '/^== stage 2: /", "awk '/== stage 2: /"],
    ['N20', 'negative_control.sh', "inside' <<<\"$stage2\")", "inside' \"$log\")"],
    ['N21', 'negative_control.sh', "grep -q '^START-GATE rpm PASS'", "grep -q 'START-GATE rpm PASS'"],
    ['N22', 'negative_control.sh', "grep -q '^START-GATE a PASS'", "grep -q 'START-GATE a PASS'"],
    ['N23', 'negative_control.sh', "grep -q '^START-GATE b PASS'", "grep -q 'START-GATE b PASS'"],
    ['N24', 'negative_control.sh', "grep -q '^START-GATE c PASS'", "grep -q 'START-GATE c PASS'"],
    ['N25', 'negative_control.sh', "grep -q '^START-GATE d FAIL'", "grep -q 'START-GATE d FAIL'"],
    ['N26', 'negative_control.sh', "grep -q '^START-GATE RESULT FAIL'", "grep -q 'START-GATE RESULT FAIL'"],
    ['N27', 'negative_control.sh', "awk '/^START-GATE d FAIL/", "awk '/START-GATE d FAIL/"],
    ['N28', 'negative_control.sh', 'grep -q ', 'grep -qi '],
    ['N29', 'negative_control.sh', "awk '/^START-GATE d FAIL/ {inside = 1; next}", "awk '/^START-GATE d / {inside = 1; next}"],
    ['N30', 'negative_control.sh', "grep -q '^START-GATE c PASS'", "grep -q '^START-GATE c '"],
    ['N31', 'negative_control.sh', '/^START-GATE / {inside = 0}', '/^START-GATE [a-c] / {inside = 0}'],
    ['N32', 'negative_control.sh', '2>/dev/null)" = 1 ]', '2>/dev/null)" -ge 1 ]'],
    // probe_start.sh
    ['P1', 'probe_start.sh', "'start failed|JS ERROR|Unhandled promise rejection'", "'JS ERROR|Unhandled promise rejection'"],
    ['P2', 'probe_start.sh', "'start failed|JS ERROR|Unhandled promise rejection'", "'start failed|Unhandled promise rejection'"],
    ['P3', 'probe_start.sh', "'start failed|JS ERROR|Unhandled promise rejection'", "'start failed|JS ERROR'"],
    ['P4', 'probe_start.sh', 'kill -TERM "$pid"', 'kill -INT "$pid"'],
    ['P5', 'probe_start.sh', '        kill -KILL "$pid"\n', ''],
    ['P6', 'probe_start.sh', 'if [ "$code" -ne 0 ]; then', 'if [ "$code" -gt 1 ]; then'],
    ['P7', 'probe_start.sh', '    sleep "$settle"\n', ''],
    ['P8', 'probe_start.sh', '[ "${#files[@]}" -ne 1 ]', '[ "${#files[@]}" -lt 1 ]'],
    ['P9', 'probe_start.sh', 'wait_action "$app_path/window/1" delete "$pid"', 'wait_action "$app_path/window/1" about "$pid"'],
    ['P10', 'probe_start.sh', '--virtual-monitor 1280x720 ', ''],
    ['P11', 'probe_start.sh', 'run_cetli e "the start at login (--autostart) opened the note that was left behind" --autostart', 'run_cetli e "the start at login (--autostart) opened the note that was left behind"'],
    ['P12', 'probe_start.sh', 'export HOME=$tmp/home', 'export HOME=$HOME'],
    ['P13', 'probe_start.sh', 'mutter --headless --wayland', 'mutter --wayland'],
    ['P14', 'probe_start.sh', '--no-x11 ', ''],
    ['P15', 'probe_start.sh', ' && [ "$(printf \'%s\\n\' "$sync_out" | wc -l)" -eq 1 ]', ''],
    ['P16', 'probe_start.sh', '"event":"result",\'', '"event":"\''],
    ['P17', 'probe_start.sh', 'if [ "$sync_code" -eq 0 ] &&', 'if true &&'],
    ['P18', 'probe_start.sh', 'fail() { echo "START-GATE $1 FAIL $2"; status=1; }', 'fail() { echo "START-GATE $1 FAIL $2"; }'],
    ['P19', 'probe_start.sh', 'exit "$status"\n', 'exit 0\n'],
    ['P20', 'probe_start.sh', 'limit=${START_GATE_TIMEOUT:-30}', 'limit=${START_GATE_TIMEOUT:-300}'],
    ['P21', 'probe_start.sh', 'settle=${START_GATE_SETTLE:-2}', 'settle=${START_GATE_SETTLE:-1}'],
    ['P22', 'probe_start.sh', '<auth>EXTERNAL</auth>\n', '<auth>EXTERNAL</auth>\n  <standard_session_servicedirs/>\n'],
    ['P23', 'probe_start.sh', 'gdbus call --session --timeout 5 --dest', 'gdbus call --session --dest'],
    ['P24', 'probe_start.sh', '        kill -0 "$3" 2>/dev/null || return 2\n', ''],
    ['P25', 'probe_start.sh', '    fail d "no display for the program"', '    pass d "no display for the program"'],
    ['P26', 'probe_start.sh', '    wait "$pid"\n    code=$?\n    if [ "$code" -ne 0 ]; then', '    wait "$pid"\n    code=0\n    if [ "$code" -ne 0 ]; then'],
    ['P27', 'probe_start.sh', 'gdbus call --session --timeout 5', 'gdbus call --system --timeout 5'],
    ['P28', 'probe_start.sh', 'trap cleanup EXIT\n', ''],
    ['P29', 'probe_start.sh', 'export WAYLAND_DISPLAY=gate-wl', 'export WAYLAND_DISPLAY=wayland-0'],
    ['P30', 'probe_start.sh', 'GDK_BACKEND=wayland', 'GDK_BACKEND=x11'],
    ['P31', 'probe_start.sh', 'HOME=$tmp/home-sync timeout', 'timeout'],
    ['P32', 'probe_start.sh', 'cetli-sync status 2>', 'cetli-sync own-id 2>'],
    ['P33', 'probe_start.sh', 'run_cetli d "the first start registered, opened its first note window, the note is on disk"', ': # run_cetli d "the first start registered, opened its first note window, the note is on disk"'],
    ['P34', 'probe_start.sh', '    kill -KILL "$pid"\n        fail "$step" "the program did not end within', '    fail "$step" "the program did not end within'],
    // probe_installed.mjs (the wiring), probe_steps.mjs (the steps: rpm-gate-steps.test.js runs them against stand-ins) and probe_logic.mjs
    ['I1', 'probe_installed.mjs', "        ['c', () => stepSignal({GLib, Gio, read})],\n", ''],
    ['I2', 'probe_installed.mjs', 'return runSteps([', 'runSteps(['],
    ['I3', 'probe_steps.mjs', 'GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15,', 'GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 2,'],
    ['I4', 'probe_steps.mjs', "'sync/engine.js', ", ''],
    ['I5', 'probe_steps.mjs', 'checkVersion(read(`${datadir}/VERSION`), expected)', 'read(`${datadir}/VERSION`)'],
    ['I6', 'probe_steps.mjs', '    checkLibadwaita(Adw.MAJOR_VERSION, Adw.MINOR_VERSION);\n', ''],
    ['T1', 'probe_steps.mjs', 'if (!id) {', 'if (false) {'],
    ['T2', 'probe_steps.mjs', '            return GLib.SOURCE_REMOVE;\n        });\n        if (!id)', '            return true;\n        });\n        if (!id)'],
    ['T3', 'probe_steps.mjs', 'GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000,', 'GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50000,'],
    ['T4', 'probe_steps.mjs', 'GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200,', 'GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000,'],
    ['T5', 'probe_steps.mjs', "            reject(new Error('SIGTERM did not arrive in the main loop within 5 s'));\n", ''],
    ['T6', 'probe_steps.mjs', '`kill -TERM ${pid}`', '`kill -TERM 1`'],
    ['T7', 'probe_steps.mjs', '`kill -TERM ${pid}`', '`kill -INT ${pid}`'],
    ['T8', 'probe_steps.mjs', "read('/proc/self/stat').split(' ')[0]", "read('/proc/self/stat').split(' ')[1]"],
    ['T9', 'probe_steps.mjs', 'if (!isFile(', 'if (false && !isFile('],
    ['T10', 'probe_steps.mjs', '            failed = true;\n', ''],
    ['T11', 'probe_steps.mjs', 'FAIL ${e?.message ?? e}`', 'FAIL ${e}`'],
    ['T12', 'probe_steps.mjs', 'return failed ? 1 : 0;', 'return 0;'],
    ['T13', 'probe_steps.mjs', '        await importModule(`file://${dir}/${f}`);', '        importModule(`file://${dir}/${f}`);'],
    ['T14', 'probe_steps.mjs', "'gi://Adw?version=1'", "'gi://Adw?version=2'"],
    ['T15', 'probe_steps.mjs', "'gi://Gtk?version=4.0'", "'gi://Gtk?version=3.0'"],
    ['T16', 'probe_steps.mjs', "export const LAUNCHER = '/usr/bin/cetli';", "export const LAUNCHER = '/usr/bin/cetli-x';"],
    ['L1', 'probe_logic.mjs', "if (!m[1].startsWith('/usr/'))", 'if (false)'],
    ['L2', 'probe_logic.mjs', 'if (version !== expected)', 'if (false)'],
    ['L3', 'probe_logic.mjs', 'minor < 5', 'minor < 4'],
    ['L4', 'probe_logic.mjs', 'major !== 1 ||', ''],
    ['L5', 'probe_logic.mjs', 'const version = installed.trim();', 'const version = installed;'],
    ['L6', 'probe_logic.mjs', '(\\/\\S+)\\/app\\/main', '(\\/\\S*)\\/app\\/main'],
    // verify_checks.sh
    ['V1', 'verify_checks.sh', 'trensoft/cetli}', 'trensoft/slideshow-lock}'],
    ['V2', 'verify_checks.sh', 'copr_project=${START_GATE_COPR_PROJECT:-cetli}', 'copr_project=${START_GATE_COPR_PROJECT:-slideshow-lock}'],
    ['V4', 'verify_checks.sh', 'run.get("conclusion") != "success"', 'run.get("conclusion") == "failure"'],
    ['V5', 'verify_checks.sh', '    elif slug != "github-actions":\n', '    elif False:\n'],
    ['V6', 'verify_checks.sh', 'for chroot in sorted(set(found) - set(wanted)):', 'for chroot in []:'],
    ['V7', 'verify_checks.sh', 'if len(legs) != 1:', 'if len(legs) == 0:'],
    ['V8', 'verify_checks.sh', 'or checks.get("total_count") != len(runs)', ''],
    ['V9', 'verify_checks.sh', '[0-9a-f]{40}', '[0-9a-f]{4}'],
    ['V10', 'verify_checks.sh', '[ -z "${GITHUB_TOKEN:-}" ] || auth=', 'auth='],
    ['V11', 'verify_checks.sh', 'curl --fail --silent --show-error --location --max-time 60 -o "$work/copr.json"', 'curl --silent --show-error --location --max-time 60 -o "$work/copr.json"'],
    ['V12', 'verify_checks.sh', 'arch = re.compile(r"-(x86_64|aarch64|ppc64le|s390x|i386|armhfp)$")', 'arch = re.compile(r"-(x86_64)$")'],
    ['V13', 'verify_checks.sh', 'if not isinstance(repos, dict) or not repos:', 'if False:'],
    ['V14', 'verify_checks.sh', 'per_page=100', 'per_page=30'],
    ['V15', 'verify_checks.sh', 'filter=latest&', ''],
    ['V16', 'verify_checks.sh', 'exit 1\n}\n\ncopr_url', 'exit 0\n}\n\ncopr_url'],
    ['V17', 'verify_checks.sh', "|| fail \"see above\"", '|| true'],
    ['V18', 'verify_checks.sh', 'set -euo pipefail', 'set -uo pipefail'],
    ['V19', 'verify_checks.sh', 'exit 2\nfi', 'exit 0\nfi'],
    ['V20', 'verify_checks.sh', 'if problems:', 'if False:'],
    // workflow
    ['W1', '.github/workflows/start-gate.yml', '          - chroot: fedora-44\n            image: registry.fedoraproject.org/fedora:44\n', ''],
    ['W2', '.github/workflows/start-gate.yml', 'fail-fast: false', 'fail-fast: true'],
    ['W3', '.github/workflows/start-gate.yml', 'timeout-minutes: 40\n    strategy', 'timeout-minutes: 400\n    strategy'],
    ['W4', '.github/workflows/start-gate.yml', '    timeout-minutes: 40\n    strategy', '    timeout-minutes: 40\n    continue-on-error: true\n    strategy'],
    ['W5', '.github/workflows/start-gate.yml', 'persist-credentials: false\n\n      - name: Build', 'persist-credentials: true\n\n      - name: Build'],
    ['W6', '.github/workflows/start-gate.yml', 'contents: read', 'contents: write'],
    ['W7', '.github/workflows/start-gate.yml', 'quay.io/centos/centos:stream10\n          - chroot: fedora-43', 'quay.io/centos/centos:latest\n          - chroot: fedora-43'],
    ['W8', '.github/workflows/start-gate.yml', '    tags: ["v*"]\n', ''],
    ['W9', '.github/workflows/negative-control.yml', '  workflow_dispatch:\n', '  pull_request:\n'],
    ['W10', '.github/workflows/negative-control.yml', 'negative_control.sh quay.io/centos/centos:stream10 .', 'negative_control.sh registry.fedoraproject.org/fedora:43 .'],
    ['W17', '.github/workflows/negative-control.yml', 'ref: ${{ github.sha }}', 'ref: v1.0.1'],
    ['W18', '.github/workflows/start-gate.yml', '    name: start gate (${{ matrix.chroot }})\n', "    name: start gate (${{ matrix.chroot }})\n    if: github.event_name != 'workflow_dispatch'\n"],
    ['W19', '.github/workflows/start-gate.yml', '  pull_request:\n', '  pull_request:\n  workflow_dispatch:\n'],
    ['W20', '.github/workflows/negative-control.yml', '    name: negative control (the gate must fail on a tree that cannot start)', '    name: start gate (epel-10)'],
    ['W21', '.github/workflows/negative-control.yml', 'persist-credentials: false', 'persist-credentials: true'],
    ['W11', '.github/workflows/start-gate.yml', 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803  # v6.1.0\n        with:\n          persist-credentials: false\n\n      - name: Build', 'actions/checkout@v4\n        with:\n          persist-credentials: false\n\n      - name: Build'],
    ['W12', '.github/workflows/start-gate.yml', 'name: start gate (${{ matrix.chroot }})', 'name: gate (${{ matrix.chroot }})'],
    ['W13', '.github/workflows/start-gate.yml', '          - chroot: epel-10\n            image: quay.io/centos/centos:stream10\n          - chroot: fedora-43\n            image: registry.fedoraproject.org/fedora:43\n', '          - chroot: fedora-43\n            image: registry.fedoraproject.org/fedora:43\n          - chroot: epel-10\n            image: quay.io/centos/centos:stream10\n'],
    ['W14', '.github/workflows/start-gate.yml', 'bash tools/start_gate/start_gate.sh "${{ matrix.image }}"', 'bash tools/start_gate/start_gate.sh quay.io/centos/centos:stream10'],
    ['W15', '.github/workflows/start-gate.yml', '  pull_request:\n', ''],
    ['W16', '.github/workflows/start-gate.yml', '    branches: [main]\n', ''],
    // a gate or a control that is green without having run (Petra, review of r2)
    ['W22', '.github/workflows/start-gate.yml', 'start_gate.sh "${{ matrix.image }}"', 'start_gate.sh "${{ matrix.image }}" || true'],
    ['W23', '.github/workflows/negative-control.yml', '      - name: The gate must fail', '      - if: false\n        name: The gate must fail'],
    ['W24', '.github/workflows/negative-control.yml', '    runs-on: ubuntu-24.04', '    if: false\n    runs-on: ubuntu-24.04'],
    ['W25', '.github/workflows/start-gate.yml', '      - name: Build the RPM', '      - if: false\n        name: Build the RPM'],
    ['W26', '.github/workflows/negative-control.yml', '        env:\n          START_GATE_ENGINE', '        continue-on-error: true\n        env:\n          START_GATE_ENGINE'],
    ['W27', '.github/workflows/negative-control.yml', 'quay.io/centos/centos:stream10 .', 'quay.io/centos/centos:stream10 . || true'],
    ['W28', '.github/workflows/negative-control.yml', '          ref: ${{ github.sha }}\n', ''],
    // the forms of `if:` that are valid YAML and that `^\s*(- )?if:` did not see (Petra, review of #8)
    ['W29', '.github/workflows/negative-control.yml', '      - name: The gate must fail', '      -  if: false\n         name: The gate must fail'],
    ['W30', '.github/workflows/negative-control.yml', '      - name: The gate must fail', '      - "if": false\n        name: The gate must fail'],
    ['W31', '.github/workflows/negative-control.yml', '    runs-on: ubuntu-24.04', '    "if": false\n    runs-on: ubuntu-24.04'],
    ['W32', '.github/workflows/start-gate.yml', '      - name: Build the RPM', '      - "if": false\n        name: Build the RPM'],
    ['W33', '.github/workflows/negative-control.yml', '    runs-on: ubuntu-24.04', "    'if': false\n    runs-on: ubuntu-24.04"],
    ['W34', '.github/workflows/start-gate.yml', '    runs-on: ubuntu-24.04', "    'if': false\n    runs-on: ubuntu-24.04"],
    // docs
    ['D1', 'docs/RELEASING.md', 'Start gate chroots (the same as the chroots of the COPR project `trensoft/cetli`): `epel-10`, `fedora-43`, `fedora-44`, `fedora-rawhide`.', ''],
    ['D2', 'docs/RELEASING.md', '`fedora-43`, `fedora-44`, `fedora-rawhide`.', '`fedora-43`, `fedora-rawhide`.'],
    ['D3', 'docs/RELEASING.md', '   - (f) `cetli-sync status`', '   - `cetli-sync status`'],
    ['D4', 'docs/RELEASING.md', 'and with no output of it there is no tag.', ''],
    ['D5', 'docs/RELEASING.md', '| `fedora-44` | `registry.fedoraproject.org/fedora:44` |\n', ''],
    ['D6', 'docs/RELEASING.md', '`tools/start_gate/negative_control.sh IMAGE TREE`', '`tools/start_gate/negative_control.sh`'],
    // the program: the call the negative control and the probe look for
    ['A1', 'app/application.js', 'GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15,', 'GLib.unix_signal_add_full(GLib.PRIORITY_DEFAULT, 15,'],
];
// every `grep -q` of the file at once: a search that ignores the case anywhere
const MANY = new Set(['N28']);
const FILES = f => f.includes('/') ? f : `${G}${f}`;

const work = mkdtempSync(path.join(tmpdir(), 'sg-mut-'));
const skip = rel => rel === '.git' || rel.startsWith(`.git${path.sep}`) || rel.split(path.sep).includes('node_modules');
cpSync(root, work, {recursive: true, filter: s => !skip(path.relative(root, s))});
const want = process.argv.slice(2);
const rows = [];
try {
    for (const [id, short, find, repl] of M) {
        if (want.length && !want.includes(id))
            continue;
        const file = FILES(short);
        const abs = path.join(work, file);
        const orig = readFileSync(path.join(root, file), 'utf8');
        const hits = orig.split(find).length - 1;
        if (MANY.has(id) ? hits < 1 : hits !== 1) {
            rows.push({id, file, verdict: 'BROKEN', note: `find text occurs ${hits} times`});
            continue;
        }
        writeFileSync(abs, MANY.has(id) ? orig.replaceAll(find, () => repl) : orig.replace(find, () => repl));
        const files = [...(FAMILY[file] ?? []).map(f => `${T}${f}.test.js`), `${T}structure.test.js`];
        const r = spawnSync('nice', ['-n', '19', process.execPath, '--test', ...files.map(f => path.join(work, f))], {encoding: 'utf8', timeout: 240000, cwd: work});
        writeFileSync(abs, orig);                       // restored at once
        const killers = [...r.stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map(m => m[1]).filter(n => !n.startsWith('/'));
        const timedOut = r.error?.code === 'ETIMEDOUT';
        rows.push({id, file, verdict: r.status === 0 && !timedOut ? 'SURVIVED' : 'KILLED', note: timedOut ? 'timed out' : killers[0] ?? `exit ${r.status}`, n: killers.length});
        console.log(`${id} ${rows.at(-1).verdict} ${rows.at(-1).note.slice(0, 110)}`);
    }
} finally {
    rmSync(work, {recursive: true, force: true});
}
const count = v => rows.filter(r => r.verdict === v).length;
console.log(`\n${rows.length} mutants: ${count('KILLED')} killed, ${count('SURVIVED')} survived, ${count('BROKEN')} broken`);
for (const r of rows.filter(r => r.verdict !== 'KILLED'))
    console.log(`  ${r.verdict} ${r.id} ${r.file}: ${r.note}`);
process.exit(count('SURVIVED') + count('BROKEN') === 0 ? 0 : 1);
