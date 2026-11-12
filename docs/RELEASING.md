# Releasing cetli

A release is a tag `v<version>` (VERSION, the spec and the first `%changelog` entry agree, see `sync-tests/packaging.test.js`) on a commit
of `main`; COPR builds the package from the tag (`.copr/Makefile`, the source type "Make srpm"). This file states only the condition that
the start gate adds; the other conditions of a release (the team gate, the tests of CI) are the team's process and are not repeated here.

**The condition:** the start gate (the section below) is green on the commit that is tagged, on every leg of its matrix, `epel-10` first.
A leg that did not run is not green: if one chroot did not run, there is no tag. The proof is the output of
`tools/start_gate/verify_checks.sh <sha>` (`VERIFY-CHECKS PASS`), run for that commit before the tag. It is the required step before the tag,
and with no output of it there is no tag.

## The start gate

The tests that need only node run the code against fakes, the smokes of `app-tests/` start the program in a headless compositor from the
source tree on a development machine. Neither starts the INSTALLED program, from the RPM, on the platform a user has. A function that is
not there on one chroot (the start-up error of slideshow-lock 1.0.11 was `GLibUnix` having no `signal_add` on EL10 and Fedora 43) ends the
program before its first window, and only a start on that chroot shows it. The start gate runs it, on every chroot that the COPR project
builds for, before the tag.

What it does, per leg (`tools/start_gate/start_gate.sh IMAGE [TREE]`, two containers of the image):

1. Stage 1 (`build.sh`): `.copr/Makefile` makes the source RPM from the commit (the file COPR runs), `dnf builddep` installs the build
   requirements, `rpmbuild --rebuild` makes the RPM (the `%check` of the spec runs in it).
2. Stage 2 (`check.sh`), in a fresh container that has neither the tree nor the build tools: `dnf` installs the RPM with its dependencies
   (`gnome-shell`, and with it `mutter`) and without the weak ones (no Syncthing), then, from the installed copy:
   - (rpm) `rpm -q` gives the file's name; on a run for a tag, the tag is `v<version of the RPM>`;
   - (a) the launcher `/usr/bin/cetli` starts the copy under `/usr/share/cetli`, and its `VERSION` is the RPM's;
   - (b) `app/application.js` (and with it every module of the program), `sync/engine.js`, `sync/gio-ports.js` and `src/index.js` import,
     with Gtk 4 and libadwaita 1.5 or later;
   - (c) a real SIGTERM reaches `GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, ...)`, the call that `application.js` makes for the
     session's SIGTERM, in a real GLib main loop;
   - (d) the real `cetli` starts in a headless `mutter` (a private D-Bus session bus that starts no program of the installed packages, a
     private home): it registers on the bus, its actions are there, the window of its first note is open (its actions are on the bus), the
     note is on disk, it runs for 2 s and ends with exit status 0 on SIGTERM. A `start failed`, `JS ERROR` or an unhandled promise rejection
     in its log fails the step whatever the exit status was;
   - (e) the same for `cetli --autostart`, what the login entry runs: the note that was left behind opens again;
   - (f) `cetli-sync status` gives its one closing line (event `result`) and exit status 0.

The steps all run, and the last line is `START-GATE RESULT PASS|FAIL`. The window itself is not looked at (it has no pixels to check in a
headless mutter): that it is open is read from the actions the program offers on the bus.

The workflow is `.github/workflows/start-gate.yml`: on every pull request, on a push to `main` and on a push of a `v*` tag, one job per
leg, named `start gate (<chroot>)`. The push to `main` is the run on the commit that is tagged. The push of a `v*` tag is not a gate: it
runs after the tag exists, so it can only report (and it checks that the tag is `v<version of the RPM>`); the COPR build of the tag does not
wait for it. What a tag waits for is `verify_checks.sh`, below. The workflow has no manual run and no `if:`: a job that is skipped leaves a
check with the raw name `start gate (${{ matrix.chroot }})` on the commit, which `verify_checks.sh` would read as a leg. The negative control,
which runs by hand, is a workflow of its own, `.github/workflows/negative-control.yml`, below. The images are the ones of the COPR chroots:

| Leg (COPR chroot) | Image |
|---|---|
| `epel-10` | `quay.io/centos/centos:stream10`, with EPEL 10 and CRB turned on |
| `fedora-43` | `registry.fedoraproject.org/fedora:43` |
| `fedora-44` | `registry.fedoraproject.org/fedora:44` |
| `fedora-rawhide` | `registry.fedoraproject.org/fedora:rawhide` |

Start gate chroots (the same as the chroots of the COPR project `trensoft/cetli`): `epel-10`, `fedora-43`, `fedora-44`, `fedora-rawhide`.

The matrix and the chroot list of the COPR project are the same list. When a chroot is added to the COPR project or taken out of it, the
matrix is changed in the same change, and the line above with it (`app-tests/rpm-gate-workflow.test.js` compares the line with the
matrix). A chroot with no leg is a chroot whose start nobody has run.

The required step before the tag is `tools/start_gate/verify_checks.sh <sha>`, with the 40 hex digits of the commit to be tagged
(`GITHUB_TOKEN` in the environment is used if there is one). It reads two APIs: the chroot list of the COPR project is read from the COPR
API (not from this file or from the workflow, so a chroot added to the project or renamed there is seen), and the check runs of the commit
from the GitHub API. For every COPR chroot there must be exactly one check `start gate (<chroot>)` of GitHub Actions that is completed with
the conclusion `success`; a leg for a chroot that the COPR project has not fails it too. A check that is red, missing, still running,
cancelled, skipped or from another app is "did not run". If an API cannot be read the script fails: no answer, no tag. A red leg is not run
again until it turns green: the cause is found, and the change goes through the team gate again.

The script is the rule of the procedure, not a lock: that the tag cannot be pushed with a red or a missing check at all is a setting of the
repository (a required status check on the four names, a tag rule), which is a decision of the maintainer's side and is not made by this file.

The negative control is `tools/start_gate/negative_control.sh IMAGE TREE`: it copies the tree, puts a start-up error of the 1.0.11 kind into
the copy (`app/application.js` calls `GLibUnix.signal_add` for the SIGTERM watch and does not import `GLibUnix`: the imports and the typelibs
are fine, the call fails the moment the program starts), commits the copy and runs the gate on it. The error is put into the tree it is
given (the checkout of the commit the run is on), there is no older tree or tag it depends on. It passes only when the gate built the RPM and
then failed in step (d), with the `ReferenceError: GLibUnix is not defined` of the copy in the log of the program that the probe prints under
the `START-GATE d FAIL` line, while (rpm), (a), (b) and (c) passed (a gate that passes is soft; a gate that fails for another reason, such as no
network, a build error, or a (d) that fails with another message, proves nothing). The workflow `negative-control.yml` runs it for the image of
`epel-10`, on the checkout of the commit the run is on (by its SHA); start it with "Run workflow" (`workflow_dispatch`) when the gate is changed
and before the first tag that depends on a changed gate.

The gate can be run by hand: `START_GATE_ENGINE=podman tools/start_gate/start_gate.sh registry.fedoraproject.org/fedora:43 [TREE]`. It needs
podman or docker and the network, so the tests do not run it (`app-tests/rpm-gate-*.test.js` run its scripts with stand-ins for the
commands). The scripts it runs in the containers are always the ones of this checkout, `TREE` may be an older one.

What the gate does not test: the GNOME Shell extension (it needs a running Shell), the appearance of the windows, the sync with another
computer, and a real session (a login, the autostart entry of the desktop).
