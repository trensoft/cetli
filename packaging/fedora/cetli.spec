# Fedora and EL spec for cetli. Pattern: the spec of slideshow-lock (same maintainer, same COPR route).
#
# Legend for the comments in this file:
#   [K]  known: read from this repository (the file is named) or from a source named in the comment
#   [M]  measured: a tool was run, the tool and what it printed are named in the comment
#   [H]  background knowledge about RPM and the Fedora packaging guidelines, NOT verified
#
# STATUS (2026-10-17): NOT built in COPR yet (the project and the repository do not exist yet). [M] Final
# measurement, on the final tree: the SRPM made by .copr/Makefile (source=worktree, because the tree is not
# committed) was rebuilt with "rpmbuild --rebuild --nodeps" (no build option given, so bcond complete is on) in two
# rootless build roots, no scriptlets run, made from the packages of the COPR logs of slideshow-lock plus make 4.4.1:
# CentOS Stream 10 (rpm 4.19.1.1, make 4.4.1, gettext 0.22.5, appstream 1.0.2) and Fedora 43 (rpm 6.0.2, make 4.4.1,
# gettext 0.25.1, appstream 1.1.3). Both built the noarch RPM and ran %%check to the end (check-po, check-complete,
# the version check, desktop-file-validate on both .desktop files, "appstreamcli validate --no-net": "Validation was
# successful"). rpmlint 2.8.0 (Fedora configuration) on each noarch RPM and SRPM: 0 errors, 3 warnings
# (no-manual-page-for-binary, files-duplicate for constants.js and layout.js, which the extension must hold as its
# own copies). Negative control, in both roots: a copy of the tree without app/main.js, or without the extension's
# metadata.json, or without its extension.js, stops %%check with "check-complete: missing: ...". NOT run: mock, COPR,
# fedora-review, an install of the RPM on a Fedora or EL machine, a real GNOME session (so the autostart script, the
# extension and the launcher were never run against a real gnome-shell), the gjs tests of app-tests/ (they are not
# part of this build), dnf (the roots were made with --nodeps, so the BuildRequires of this spec were not resolved
# by dnf; their names were read from the CentOS Stream 10 repodata). The RPM holds /usr/bin/cetli, which starts
# app/main.js: %%check runs "make check-complete" (bcond complete, on by default).
#
# Decisions that are not in this repository (Jenna 6638/6644, Attila approved, 2026-10-17):
#   - The name is cetli everywhere; the owner shown outside is TrenSoft; License GPL-3.0-or-later.
#   - The package recommends syncthing. Since 0.2.5 the sync window of cetli (menu: Sync...) can set up a Syncthing instance of its own
#     after the user presses a button (A7, Attila via Jenna 8322); the package itself configures, enables and starts nothing.
#   - The build root of record is the epel-10 chroot of COPR (RHEL 10, GNOME Shell 47 to 49); the Fedora chroots
#     are built too. The version comes from the file VERSION of the repository: .copr/Makefile writes it into
#     Version: of the spec it builds from, and %%check stops the build when the two differ.

%global app_id io.github.trensoft.cetli
%global uuid   cetli@trensoft.local
# [K] app_id is the application id, the name of the .desktop file, the metainfo file and the icon; uuid is the
# extension directory (Makefile: APP_ID, UUID)

%{!?_metainfodir:%global _metainfodir %{_datadir}/metainfo}
# [H] %%{_metainfodir} is not defined by every rpm; the usual place is /usr/share/metainfo

# On by default: %%check stops when app/main.js or the extension is not in the sources, so a build of a tree
# without them cannot pass as a complete package. "--without complete" turns the check off (a packaging-only try).
%bcond complete 1

Name:           cetli
Version:        0.2.6
Release:        1%{?dist}
Summary:        Small notes on the GNOME desktop that sync between your computers
License:        GPL-3.0-or-later
URL:            https://github.com/trensoft/cetli
Source0:        %{url}/archive/v%{version}/%{name}-%{version}.tar.gz
# [H] the usual form of a GitHub tag tarball; unpacks into cetli-%%{version}/. COPR builds from .copr/Makefile,
# which puts a tarball of that name into the source directory, so nothing is downloaded.

BuildArch:      noarch
# [K] JavaScript and data only

BuildRequires:  make
BuildRequires:  gettext
BuildRequires:  desktop-file-utils
BuildRequires:  appstream
BuildRequires:  glib2-devel
BuildRequires:  systemd-rpm-macros
# [K] make: the Makefile builds and installs; gettext: msgfmt, xgettext, msgcmp; desktop-file-utils:
# desktop-file-validate; appstream: appstreamcli; glib2-devel: glib-compile-schemas, only if the extension gets a
# schema (Makefile, install). [M] all five names exist in CentOS Stream 10 (make, gettext in BaseOS; the others in
# AppStream; repodata read 2026-10-17); libappstream-glib exists there too (0.8.3) and is not needed.
# systemd-rpm-macros (0.2.5): only for the macro %%{_userunitdir}, where the unit file of the sync window is installed (the EPEL spec of
# syncthing does the same). [H] it is in the COPR chroots: the first build tells. No %%systemd_user_* scriptlet is used: the package enables
# and restarts nothing; the sync window enables the unit after the user's click.

Requires:       gnome-shell >= 47
Requires:       gjs
Requires:       gtk4
Requires:       libadwaita >= 1.5
Requires:       hicolor-icon-theme
# [K] PLAN.md section 6 and 9.5: libadwaita 1.5 is the first with Adw.AboutDialog. [M] CentOS Stream 10 AppStream has
# gnome-shell 49.5, gjs 1.80.2, gtk4 4.16.x, libadwaita 1.6.x (repodata, 2026-10-17).
Recommends:     syncthing
# [K] PLAN.md section 6: Recommends, not Requires. syncthing is in EPEL 10, not in the RHEL or CentOS Stream
# AppStream, so on EL10 it is installed only where EPEL is enabled.

%description
cetli keeps short notes in small windows on the GNOME desktop. Every note is
one plain file in a folder, so the folder can be kept in step between
computers with a tool such as Syncthing (the package recommends it). The sync
window of cetli (menu: Sync) sets up a Syncthing instance of its own after you
press a button; the package itself starts nothing. If two computers change the
same note before they meet, cetli keeps both versions.

The package also holds a GNOME Shell extension that puts the note windows back
where they were. It is enabled once, at the first login of each user.

%prep
%autosetup

%build
%make_build pot all PREFIX=%{_prefix} LIBEXECDIR=%{_libexecdir}
# "pot" writes po/cetli.pot from the sources (the template is made in the build, not only read)

%install
%make_install PREFIX=%{_prefix} SYSCONFDIR=%{_sysconfdir} LIBEXECDIR=%{_libexecdir} LOCALEDIR=%{_datadir}/locale USERUNITDIR=%{_userunitdir}
%find_lang %{name}

%check
make check-po
%if %{with complete}
make check-complete
%endif
test "$(cat %{buildroot}%{_datadir}/%{name}/VERSION)" = "%{version}"
test -f %{buildroot}%{_userunitdir}/%{name}-syncthing.service
test -f %{buildroot}%{_datadir}/%{name}/sync/main.js
grep -q '<release version="%{version}" ' %{buildroot}%{_metainfodir}/%{app_id}.metainfo.xml
sh -n %{buildroot}%{_libexecdir}/%{name}/enable-extension
desktop-file-validate %{buildroot}%{_datadir}/applications/%{app_id}.desktop
desktop-file-validate %{buildroot}%{_sysconfdir}/xdg/autostart/%{app_id}.enable-extension.desktop
appstreamcli validate --no-net %{buildroot}%{_metainfodir}/%{app_id}.metainfo.xml

%files -f %{name}.lang
%license LICENSE
%doc README.md
%{_bindir}/%{name}
%{_bindir}/%{name}-sync
%{_userunitdir}/%{name}-syncthing.service
%{_datadir}/%{name}/
%{_libexecdir}/%{name}/
%{_datadir}/gnome-shell/extensions/%{uuid}/
%{_datadir}/applications/%{app_id}.desktop
%{_metainfodir}/%{app_id}.metainfo.xml
%{_datadir}/icons/hicolor/scalable/apps/%{app_id}.svg
%config(noreplace) %{_sysconfdir}/xdg/autostart/%{app_id}.enable-extension.desktop

%changelog
* Mon Oct 19 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.6-1
- Fix: the line "Not connected right now" in the sync window could stay on while notes synced both ways. The window now asks again every 3 seconds while the page with the other computer is on screen, so the line follows the connection (also when it breaks later). A check whose call failed is shown as "Checking the connection", never as "Not connected right now".
- Fix: a note window that holds nothing unsaved closes by itself when the other computer deletes the note (or the note file disappears). A window with unsaved text or a save still waiting stays open with the mark, and typing or saving brings the note back, as before.
- Fix: "New note" makes one note per press (a quick second press made a second note), the empty list does not give the keyboard focus to its "New note" button (an Enter or a Space typed into the window that just appeared made a note), and a note that cannot be saved is reported in the list.
- Fix: the sync restart does not start the sync program when systemd cannot say clearly whether it is switched off (masked, no answer); a restart that fails because of systemd now offers "Try again" and "Reset sync". "Reset sync" looks at the marker folder of cetli again right before it takes it away.
- Measured since 0.2.5.2 (John, Syncthing 2.1.6): the marker folder of Syncthing holds one plain file, syncthing-folder-90ca15.txt (117 bytes).
- Tests: the engine and window tests of these changes (sync-tests/engine-connect.test.js, engine-recover.test.js, flow.test.js; app-tests/link-poll-smoke.js, new-note-guard-smoke.js, gtk-smoke.js); the mutants R5, R6, R11, R12, R13 (sync-tests/mutants-recover.js) are all killed.
- Not measured: a real GNOME Shell, a real mouse click, a real synchronised pair of computers, a real systemd user session, a real note window that closes when the other computer deletes the note, and a real Syncthing state during a package change.

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5.4-1
- Fix: the header of a note no longer shows "N unresolved". The copies that Syncthing makes when two computers change a note at the same time (files named <id>.sync-conflict-<date>-<time>-<id>.json) were kept but never resolved, so the counter only grew. The program now resolves them by itself, without losing a text: the newest version becomes the note, and every other version is kept as a note of its own (same text, same colour, no mark and no changed title); the conflict file is deleted only after its text is safe in a note. A frozen note (its own file damaged or not readable) is left as it is, with the conflict files.
- Fix: the error text of a sync program that does not answer no longer asks the user to run a command (journalctl); it says only that the sync was started and does not answer, and to try again. The Hungarian text is changed too; the other catalogs had no translation of it yet.
- Tests: app-tests/conflict-resolve-smoke.js starts the real application on a synchronised folder with live notes and three conflict copies of different texts (one newer than its main file); tests/resolve.test.js still holds that the store itself is off by default. Not measured: a real Syncthing conflict on the computer where the counter showed; whether the copies of a long-running session look the same on screen as in this start test.

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5.3-1
- Fix: on a synchronised notes folder with no live note (for example after all notes were deleted: the folder then holds only deleted records), the start opens the list of notes, and its empty page had no way to a first note. The empty page now has a "New note" button. It makes the first note the same way as the menu does, so it is red (Important), and opens its window. Nothing else changes: on a folder that is not synchronised the start still makes one red note, and the start of a synchronised folder still makes no note by itself.
- Tests: three start-gate smokes drive the real application (app-tests/synced-start-deleted-smoke.js: marker, deleted records, no live note; app-tests/synced-start-empty-smoke.js: marker, empty folder; app-tests/unsynced-start-smoke.js: no marker, the old path). Not measured: a real synchronised pair; the Hungarian and other catalogs are unchanged (the button text is the existing "New note").

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5.2-1
- Fix: when the sync program of cetli is set up but does not answer, the error window now has a way out. When the window opens and the sync program does not answer, the window starts it again by itself, once per opening and without a click; a computer that was paired reconnects after an update or a restart without anybody pressing anything, also when the unit of the sync program is not running (inactive, failed, start limit; measured with Syncthing 2.1.6: then the status answers E_SERVICE_TIMEOUT after 5-6 s). A unit that the user switched off (cetli-sync forget --stop) is left off by the automatic try; the button then runs enable --now. A restart that ends on E_CONFIG_UNSAFE offers Reset sync as well. If that does not help, "Try again" starts the sync program again (it clears the failed state of the unit, restarts it and waits for it) and touches no data. If the sync program still does not answer, "Reset sync" is the last resort (the computer gets a new ID, so the pairing has to be made again; the confirmation says so) and asks first, then stops the unit, moves the own directory of the sync program (its identity, key and settings) aside under a time-stamped name beside it, takes away the marker of the folder that cetli itself set up, and opens the ID page with a new ID of this computer. It deletes no note and nothing else; the other computer must stop syncing as well, because it accepts one partner. Both steps are also available as cetli-sync restart and cetli-sync reset.
- Tests: the engine, the window and the two new commands have tests (sync-tests/engine-recover.test.js, app-tests/sync-wizard-smoke.js). Not measured: a real systemd user service that does not answer, the marker directory of a real Syncthing (the check accepts an empty directory or one that holds only a file named syncthing-folder-<letters and digits>.txt), two real computers. The reason why the sync program does not answer on the computer that showed the error is not known yet; this release does not change that.

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5.1-1
- Fix: on a synchronised notes folder the program no longer makes a new (red) note at the start. Before, a computer whose folder was still empty at the start made one, and it reached every paired computer. When there is no note in the folder, the start opens the list of notes instead, the first time and every time after
- Tests: a unit test for the check; not measured: the restart with two real computers (it is part of the 0.2.6 test)

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5-1
- New: a sync window (main menu: Sync, and once at the first start): it sets up a Syncthing instance of its own for the notes folder after you press a button, and connects two computers by their device IDs. Both computers show their ID; on the waiting computer one button accepts the computer that knocks, and only after you have compared the ID shown there with the one on the other computer; or the ID of the other computer is typed in. cetli opens a network port and announces itself on the local network while the service runs
- Supported and measured: two computers; cetli pairs a computer with exactly one other computer. Three or more computers cannot be set up in this version: a computer that is already paired refuses a second one. Not measured: a real network behind a default firewall or NAT, connections through relays, a real RHEL 10 with a user service manager. A firewall on either computer can stop the pairing: the ports are TCP and UDP 22100 and UDP 21127
- A machine whose notes folder is already synchronised by a Syncthing you set up by hand is detected and left exactly as it is; the window says so. Two Syncthings on one folder can lose an update (measured)
- The window says Connected only when the engine has proof from the other computer's side (a stable link, measured with two real Syncthing instances); if the proof does not come in time, the window says "still waiting"
- The package installs the unit cetli-syncthing.service and the program cetli-sync as data; nothing is enabled or started by the package
- Tests: the engine and the window have their own tests (sync-tests/, app-tests/sync-wizard-smoke.js)

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.4-1
- The very first note (when no note exists yet) is red (RHEL red, #ee0000); every later new note gets a colour as before. The red is the first circle of the colour grid; no existing note changes colour
- The header of a red note shows the title "Important" (white, bold, larger than the text, in the middle, cut with an ellipsis on a very small window, as readable in a window that is not active); the title is translated in the language catalogs, the other texts of the new catalogs stay English until they are translated
- The text of a red note is bold (a look of the colour: nothing is stored in the note)
- Fix: a note with a custom colour (the red, #3f3d3c, #336699 ...) drew black text when it started from its file; the text colour is right now

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.3-1
- No change to the application: the app/ code is identical to 0.2.2
- Tests only: the All notes bulk smoke test now uses 50 notes (not 1000 files) with stricter limits (build 250 ms, refresh 10 ms) and exits after its result instead of hanging
- Tests only: run.sh stops the bulk smoke test after 120 s, so a hang counts as a failure instead of an endless wait
- Tests only: the formatting bar render smoke test waits for the frame clock instead of a fixed sleep (15 s cap)

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.2-1
- Menu rearranged: a "+" button for a new note in the header bar (Ctrl+N); the main menu holds the colour grid on top, then All notes (Ctrl+H), Delete note and About
- Colour grid with round swatches: yellow, pink, green, purple, blue, gray, charcoal (#3f3d3c), white and RHEL red (#ee0000), and a last circle for a custom #rrggbb colour; orange, mint and peach are no longer offered, notes that have them keep them
- All notes window: a search field, one card per note (colour, time of the last change, first lines), an eye to hide or show the note window, a trash button with a confirmation, the most recently changed note first
- The cards of the All notes window show the formatting of a note when it is intact, plain text otherwise
- Formatting bar: bold, italic, underline and strikethrough on the selected text (Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+Shift+X); the buttons work on a selection only, there is no typing style, and a paste is plain text
- Formatting is stored beside the text as a list of ranges ("marks"); formatting never changes the text, and a note without formatting is saved as before
- Notes written by cetli 0.1.0 or 0.2.0 open as before and keep the formatting data; after such a version edits the text, 0.2.2 shows that note without formatting, the text is intact
- Known limit: Ctrl+Z does not undo a formatting change

* Sat Oct 17 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.0-1
- Eight note colours: yellow, pink, green, purple, orange, blue, mint, peach
- A new note starts with a random base colour
- Custom RGB colour picker for a note
- The program is named Cetli

* Sat Oct 17 2026 TrenSoft <trensoft@fedoraproject.org> - 0.1.0-1
- Packaging skeleton: Makefile, gettext catalogs (hu, en), desktop file, metainfo, placeholder icon
- Enable the GNOME Shell extension once at the first login of a user
