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
#   - The package recommends syncthing and does not configure it: the program writes the notes folder and
#     Syncthing is set up by hand (the automation waits for a decision of the fleet lead).
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
Version:        0.2.0
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
# [K] make: the Makefile builds and installs; gettext: msgfmt, xgettext, msgcmp; desktop-file-utils:
# desktop-file-validate; appstream: appstreamcli; glib2-devel: glib-compile-schemas, only if the extension gets a
# schema (Makefile, install). [M] all five names exist in CentOS Stream 10 (make, gettext in BaseOS; the others in
# AppStream; repodata read 2026-10-17); libappstream-glib exists there too (0.8.3) and is not needed.

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
computers with a tool such as Syncthing (the package recommends it, and does
not set it up). If two computers change the same note before they meet, cetli
keeps both versions.

The package also holds a GNOME Shell extension that puts the note windows back
where they were. It is enabled once, at the first login of each user.

%prep
%autosetup

%build
%make_build pot all PREFIX=%{_prefix} LIBEXECDIR=%{_libexecdir}
# "pot" writes po/cetli.pot from the sources (the template is made in the build, not only read)

%install
%make_install PREFIX=%{_prefix} SYSCONFDIR=%{_sysconfdir} LIBEXECDIR=%{_libexecdir} LOCALEDIR=%{_datadir}/locale
%find_lang %{name}

%check
make check-po
%if %{with complete}
make check-complete
%endif
test "$(cat %{buildroot}%{_datadir}/%{name}/VERSION)" = "%{version}"
grep -q '<release version="%{version}" ' %{buildroot}%{_metainfodir}/%{app_id}.metainfo.xml
sh -n %{buildroot}%{_libexecdir}/%{name}/enable-extension
desktop-file-validate %{buildroot}%{_datadir}/applications/%{app_id}.desktop
desktop-file-validate %{buildroot}%{_sysconfdir}/xdg/autostart/%{app_id}.enable-extension.desktop
appstreamcli validate --no-net %{buildroot}%{_metainfodir}/%{app_id}.metainfo.xml

%files -f %{name}.lang
%license LICENSE
%doc README.md
%{_bindir}/%{name}
%{_datadir}/%{name}/
%{_libexecdir}/%{name}/
%{_datadir}/gnome-shell/extensions/%{uuid}/
%{_datadir}/applications/%{app_id}.desktop
%{_metainfodir}/%{app_id}.metainfo.xml
%{_datadir}/icons/hicolor/scalable/apps/%{app_id}.svg
%config(noreplace) %{_sysconfdir}/xdg/autostart/%{app_id}.enable-extension.desktop

%changelog
* Sat Oct 17 2026 TrenSoft <trensoft@fedoraproject.org> - 0.2.0-1
- Eight note colours: yellow, pink, green, purple, orange, blue, mint, peach
- A new note starts with a random base colour
- Custom RGB colour picker for a note
- The program is named Cetli

* Sat Oct 17 2026 TrenSoft <trensoft@fedoraproject.org> - 0.1.0-1
- Packaging skeleton: Makefile, gettext catalogs (hu, en), desktop file, metainfo, placeholder icon
- Enable the GNOME Shell extension once at the first login of a user
