# Fedora and EL spec for cetli. The version comes from the file VERSION: .copr/Makefile writes it into Version:, and
# %%check stops the build when the two differ.

%global app_id io.github.trensoft.cetli
%global uuid   cetli@trensoft.local

%{!?_metainfodir:%global _metainfodir %{_datadir}/metainfo}

# On by default: %%check stops when app/main.js or the extension is not in the sources. "--without complete" skips it.
%bcond complete 1

Name:           cetli
Version:        1.0.0
Release:        1%{?dist}
Summary:        Small notes on the GNOME desktop that sync between your computers
License:        GPL-3.0-or-later
URL:            https://github.com/trensoft/cetli
Source0:        %{url}/archive/v%{version}/%{name}-%{version}.tar.gz
# COPR builds from .copr/Makefile, which puts a tarball of that name into the source directory.

BuildArch:      noarch

BuildRequires:  make
BuildRequires:  gettext
BuildRequires:  desktop-file-utils
BuildRequires:  appstream
BuildRequires:  libappstream-glib
BuildRequires:  glib2-devel
# systemd-rpm-macros: %%{_userunitdir} and the user unit scriptlets
BuildRequires:  systemd-rpm-macros

Requires:       gnome-shell >= 47
Requires:       gjs
# `mv --exchange` (renameat2 RENAME_EXCHANGE) is in coreutils 9.5 and later; src/gio-layer.js starts /usr/bin/mv with it
Requires:       coreutils >= 9.5
Requires:       gtk4
# libadwaita 1.5 is the first with Adw.AboutDialog
Requires:       libadwaita >= 1.5
Requires:       hicolor-icon-theme
# Recommends, not Requires: syncthing is in EPEL 10, not in the RHEL or CentOS Stream AppStream
Recommends:     syncthing

%description
cetli keeps short notes in small windows on the GNOME desktop. Every note is
one plain file in a folder, so the folder can be kept in step between
computers with a tool such as Syncthing (the package recommends it). The sync
window of cetli (menu: Sync) sets up a Syncthing instance of its own after you
press a button; the package itself starts nothing. If two computers change the
same note before they meet, cetli keeps both versions.

The package also holds a GNOME Shell extension that puts the note windows back
where they were. It is enabled once, at the first login of each user. cetli
itself starts at login and opens the notes that were left open (a login entry
that each user can turn off, see the README).

%prep
%autosetup

%build
%make_build pot all PREFIX=%{_prefix} LIBEXECDIR=%{_libexecdir}
# "pot" writes po/cetli.pot from the sources (the template is made in the build, not only read)

%install
%make_install PREFIX=%{_prefix} SYSCONFDIR=%{_sysconfdir} LIBEXECDIR=%{_libexecdir} LOCALEDIR=%{_datadir}/locale USERUNITDIR=%{_userunitdir} MANDIR=%{_mandir}
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
desktop-file-validate %{buildroot}%{_sysconfdir}/xdg/autostart/%{app_id}.desktop
appstreamcli validate --no-net %{buildroot}%{_metainfodir}/%{app_id}.metainfo.xml
appstream-util validate-relax --nonet %{buildroot}%{_metainfodir}/%{app_id}.metainfo.xml

# The sync window enables the unit after the user's click. The scriptlets are the macros of systemd-rpm-macros, whose text is
# the same in the macros.systemd of EL10 (systemd 257), Fedora 43 (258) and Fedora 44 (259): %%systemd_user_post calls
# `systemd-update-helper install-user-units` on a first installation ($1 = 1), %%systemd_user_preun calls
# `systemd-update-helper remove-user-units` on a removal ($1 = 0), not on an update, and %%systemd_user_postun expands to nothing.
# There is no restart on update (%%systemd_user_postun_with_restart would mark the unit for one and stop a running sync).
%post
%systemd_user_post %{name}-syncthing.service

%preun
%systemd_user_preun %{name}-syncthing.service

# Intended: %%systemd_user_postun without restart expands to nothing, rpmlint reports empty-%%postun.
%postun
%systemd_user_postun %{name}-syncthing.service

%files -f %{name}.lang
%license LICENSE
%doc README.md
%{_bindir}/%{name}
%{_bindir}/%{name}-sync
%{_mandir}/man1/%{name}.1*
%{_mandir}/man1/%{name}-sync.1*
%{_userunitdir}/%{name}-syncthing.service
%{_datadir}/%{name}/
%{_libexecdir}/%{name}/
%{_datadir}/gnome-shell/extensions/%{uuid}/
%{_datadir}/applications/%{app_id}.desktop
%{_metainfodir}/%{app_id}.metainfo.xml
%{_datadir}/icons/hicolor/scalable/apps/%{app_id}.svg
%config(noreplace) %{_sysconfdir}/xdg/autostart/%{app_id}.enable-extension.desktop
%config(noreplace) %{_sysconfdir}/xdg/autostart/%{app_id}.desktop

%changelog
* Tue Oct 20 2026 TrenSoft <trensoft@fedoraproject.org> - 1.0.0-1
- Update to 1.0.0
- Saving a note no longer overwrites a version that the sync program delivers at the same moment; that version is kept in backup/

* Mon Oct 19 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.8-2
- Add systemd user unit scriptlets; trim spec comments and changelog (review feedback)

* Mon Oct 19 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.8-1
- New: cetli starts when you log in to GNOME and opens the notes that were left open (XDG autostart entry, runs `cetli --autostart`)
- To turn it off, put a file with Hidden=true and the same name into ~/.config/autostart (see the README)

* Mon Oct 19 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.7-1
- Fix: a note could lose its newest text when the sync program delivered a newer version while cetli settled a sync conflict; cetli now swaps the note in with one atomic step (`mv --exchange`, so coreutils 9.5 or later is required) and keeps a version it had not read in backup/ beside the notes folder
- New: cetli syncs up to 10 computers; a computer you accept can add other computers to your group, so remove a lost computer on all your computers
- Fix: at start, cetli starts its sync program again when it was stopped (also `cetli-sync ensure`)

* Mon Oct 19 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.6-1
- Fix: the connection line of the sync window follows the real state
- Fix: a note window that holds nothing unsaved closes when the other computer deletes the note
- Fix: "New note" makes one note per press; a failed sync restart offers "Try again" and "Reset sync"

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5.4-1
- Fix: the "N unresolved" counter; the conflict copies of Syncthing are resolved without losing a text
- Fix: the error text of a sync program that does not answer no longer asks the user to run a command

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5.3-1
- Fix: the empty list of notes of a synchronised folder has a "New note" button

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5.2-1
- Fix: the sync window starts a sync program that does not answer; "Try again" and "Reset sync" (also `cetli-sync restart` and `reset`) are the way out

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5.1-1
- Fix: on a synchronised folder the start no longer makes a new red note; with no note it opens the list of notes

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.5-1
- New: a sync window (menu: Sync) that sets up a Syncthing instance of its own and connects two computers by their device IDs
- The package installs the unit cetli-syncthing.service and the program cetli-sync

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.4-1
- The very first note is red (RHEL red, #ee0000) with the title "Important" and bold text
- Fix: a note with a custom colour drew black text when it started from its file

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.3-1
- No change to the application; tests only

* Sun Oct 18 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.2-1
- Menu rearranged: a "+" button for a new note, a colour grid, the All notes window with search
- Formatting bar: bold, italic, underline and strikethrough on the selected text

* Sat Oct 17 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.0-1
- Eight note colours and a custom RGB colour picker; a new note starts with a random base colour
- The program is named Cetli

* Sat Oct 17 2026 TrenSoft <trensoft@fedoraproject.org> - 0.1.0-1
- Packaging skeleton: Makefile, gettext catalogs (hu, en), desktop file, metainfo, placeholder icon
- Enable the GNOME Shell extension once at the first login of a user
