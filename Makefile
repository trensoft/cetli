# SPDX-License-Identifier: GPL-3.0-or-later
# Build, check and install cetli. Needs make, a POSIX shell with find and sed, and gettext (msgfmt, xgettext,
# msgmerge, msgcmp, msginit). Nothing here reads the network or a secret.
#
#   make pot                   write po/cetli.pot from po/POTFILES.in, the desktop file and the metainfo template
#   make update-po             merge the template into every catalog (po/LINGUAS)
#   make newlang LANG=xx       start po/xx.po and add xx to po/LINGUAS (LANG must be given on the command line)
#   make check-po              every catalog compiles; po/LINGUAS and po/POTFILES.in agree with the tree
#   make check-po-sync         every catalog holds every string of a fresh template (run update-po if not)
#   make check-version         VERSION agrees with the spec; says if the extension metadata differs
#   make check-complete        app/main.js and the extension are in the tree (an RPM without them is a skeleton)
#   make check                 all of the above except check-complete
#   make                       compile the catalogs and generate the desktop files, the metainfo and the launcher
#   make install DESTDIR= PREFIX=/usr [USERUNITDIR=/usr/lib/systemd/user]
#   make clean
#
# VERSION is the one source of the version number: this file, the metainfo and the metadata.json of the extension
# take it from there, and so does the About window (it reads $(DATADIR)/cetli/VERSION).

NAME     := cetli
APP_ID   := io.github.trensoft.cetli
UUID     := cetli@trensoft.local
VERSION  := $(shell tr -d ' \t\r\n' < VERSION 2>/dev/null)
ifeq ($(shell printf '%s' '$(VERSION)' | grep -cE '^[0-9][0-9A-Za-z.+~]*$$'),0)
$(error VERSION must hold a version such as 0.1.0, not '$(VERSION)')
endif

DESTDIR    ?=
PREFIX     ?= /usr
BINDIR     ?= $(PREFIX)/bin
DATADIR    ?= $(PREFIX)/share
LIBEXECDIR ?= $(PREFIX)/libexec
USERUNITDIR ?= $(PREFIX)/lib/systemd/user
SYSCONFDIR ?= /etc
LOCALEDIR  ?= $(DATADIR)/locale
INSTALL    ?= install

# The date of the release entry of the metainfo: the build date of the package when rpmbuild gives
# SOURCE_DATE_EPOCH (the date of the newest %changelog entry), otherwise today (UTC).
RELEASE_DATE ?= $(if $(SOURCE_DATE_EPOCH),$(shell date -u -d @$(SOURCE_DATE_EPOCH) +%F),$(shell date -u +%F))
COPYRIGHT_YEAR := 2026
XGETTEXT_FLAGS = --from-code=UTF-8 --package-name=$(NAME) --package-version=$(VERSION) --copyright-holder=TrenSoft \
    --msgid-bugs-address=https://github.com/trensoft/cetli/issues --add-location=file

BUILD    := build
POT      := po/$(NAME).pot
LINGUAS  := $(shell sed 's/\#.*//' po/LINGUAS 2>/dev/null)
POTLIST  := $(shell sed 's/\#.*//' po/POTFILES.in 2>/dev/null)
POTJS    := $(filter %.js,$(POTLIST))
POTJS_IN_TREE := $(wildcard $(POTJS))
POTJS_MISSING := $(filter-out $(POTJS_IN_TREE),$(POTJS))
DESKTOP_IN  := data/$(APP_ID).desktop.in
METAINFO_IN := data/$(APP_ID).metainfo.xml.in
AUTOSTART_IN := data/$(APP_ID).enable-extension.desktop.in
AUTOSTART_APP_IN := data/$(APP_ID).autostart.desktop.in
EXT_SRC  := extension/$(UUID)

# Words in a source file that make it a file with translatable strings (see check-potfiles).
GETTEXT_CALL := (^|[^A-Za-z0-9_])(_|N_|C_|gettext|ngettext|pgettext)\(

.PHONY: all mo data pot update-po newlang install clean check check-po check-po-sync check-potfiles \
        check-version check-complete

all: mo data

# ---------------------------------------------------------------------------------------------- catalogs

mo: $(foreach l,$(LINGUAS),$(BUILD)/locale/$(l)/LC_MESSAGES/$(NAME).mo)

$(BUILD)/locale/%/LC_MESSAGES/$(NAME).mo: po/%.po
	mkdir -p $(dir $@)
	msgfmt -c --check -o $@ $<

# The template: the desktop file, the metainfo and the JavaScript files named in po/POTFILES.in. A name in the
# list that is not in the tree yet is skipped with a note (the files of the others arrive over the day);
# check-potfiles is the other way round: a file with translatable strings that is not in the list is an error.
pot:
	@mkdir -p $(dir $(POT))
	@old=$$(sed -n 's/^"POT-Creation-Date: \(.*\)\\n"$$/\1/p' $(POT) 2>/dev/null | head -n 1); \
	tmp=$(POT).new; rm -f $$tmp; \
	xgettext --language=Desktop -k --keyword=Name --keyword=Comment $(XGETTEXT_FLAGS) -o $$tmp $(DESKTOP_IN) || exit 1; \
	sed -i 's/charset=CHARSET/charset=UTF-8/' $$tmp; \
	xgettext -j $(XGETTEXT_FLAGS) -o $$tmp $(METAINFO_IN) || exit 1; \
	for f in $(POTJS_MISSING); do echo "pot: not in the tree yet, skipped: $$f" >&2; done; \
	if test -n '$(POTJS_IN_TREE)'; then \
	    xgettext -j --language=JavaScript $(XGETTEXT_FLAGS) \
	        -k_ -kN_ -kC_:1c,2 -kgettext -kngettext:1,2 -kpgettext:1c,2 -o $$tmp $(POTJS_IN_TREE) || exit 1; \
	fi; \
	if test -n "$$SOURCE_DATE_EPOCH"; then d=$$(date -u -d @$$SOURCE_DATE_EPOCH '+%Y-%m-%d %H:%M+0000'); \
	elif test -n "$$old"; then d=$$old; else d=$$(date -u '+%Y-%m-%d %H:%M+0000'); fi; \
	sed -i -e "s/^\"POT-Creation-Date: .*\\\\n\"$$/\"POT-Creation-Date: $$d\\\\n\"/" \
	    -e 's/Copyright (C) YEAR /Copyright (C) $(COPYRIGHT_YEAR) /' \
	    -e 's/^\# SOME DESCRIPTIVE TITLE\./\# Translation template of $(NAME)./' -e '/^\# FIRST AUTHOR/d' $$tmp; \
	mv $$tmp $(POT); echo "wrote $(POT)"

update-po: pot
	@for l in $(LINGUAS); do echo "msgmerge $$l"; msgmerge --update --backup=none --quiet po/$$l.po $(POT) || exit 1; done

# LANG is also an environment variable (the locale of the shell): only the command line counts.
newlang:
	@test '$(origin LANG)' = 'command line' || { echo 'usage: make newlang LANG=xx (a language code such as de or pt_BR)' >&2; exit 2; }
	@printf '%s' '$(LANG)' | grep -qE '^[a-z]{2,3}(_[A-Z]{2})?$$' || { echo 'newlang: "$(LANG)" is not a language code such as de or pt_BR' >&2; exit 2; }
	@test ! -e po/$(LANG).po || { echo 'newlang: po/$(LANG).po exists' >&2; exit 1; }
	@test -f $(POT) || $(MAKE) pot
	msginit --no-translator --locale=$(LANG).UTF-8 --input=$(POT) --output-file=po/$(LANG).po
	@{ grep '^\#' po/LINGUAS; { grep -v '^\#' po/LINGUAS; echo $(LANG); } | sort -u; } > po/LINGUAS.new && mv po/LINGUAS.new po/LINGUAS && echo "added $(LANG) to po/LINGUAS"

# ---------------------------------------------------------------------------------------------- generated files

data: $(BUILD)/$(APP_ID).desktop $(BUILD)/$(APP_ID).metainfo.xml $(BUILD)/$(APP_ID).enable-extension.desktop \
      $(BUILD)/$(APP_ID).autostart.desktop $(BUILD)/$(NAME) $(BUILD)/$(NAME)-sync

$(BUILD)/$(APP_ID).desktop: $(DESKTOP_IN) po/LINGUAS $(wildcard po/*.po)
	mkdir -p $(BUILD)
	msgfmt --desktop -d po --template $< -o $@

# The placeholders are not translatable text; they are filled in before msgfmt reads the template.
$(BUILD)/$(APP_ID).metainfo.xml: $(METAINFO_IN) VERSION po/LINGUAS $(wildcard po/*.po)
	mkdir -p $(BUILD)
	sed -e 's/@VERSION@/$(VERSION)/g' -e 's/@RELEASE_DATE@/$(RELEASE_DATE)/g' $< > $(BUILD)/$(APP_ID).metainfo.xml.in
	msgfmt --xml -d po --template $(BUILD)/$(APP_ID).metainfo.xml.in -o $@

$(BUILD)/$(APP_ID).enable-extension.desktop: $(AUTOSTART_IN)
	mkdir -p $(BUILD)
	sed -e 's#@LIBEXECDIR@#$(LIBEXECDIR)#g' $< > $@

# The start of the program at login (0.2.8). A user turns it off with an override of the same file name in ~/.config/autostart (README).
$(BUILD)/$(APP_ID).autostart.desktop: $(AUTOSTART_APP_IN)
	mkdir -p $(BUILD)
	sed -e 's#@BINDIR@#$(BINDIR)#g' $< > $@

$(BUILD)/$(NAME): Makefile
	mkdir -p $(BUILD)
	printf '%s\n' '#!/bin/sh' 'exec gjs -m $(DATADIR)/$(NAME)/app/main.js "$$@"' > $@

# The engine of the sync window (sync/main.js): started by the window's bridge, or by hand in a terminal.
$(BUILD)/$(NAME)-sync: Makefile
	mkdir -p $(BUILD)
	printf '%s\n' '#!/bin/sh' 'exec gjs -m $(DATADIR)/$(NAME)/sync/main.js "$$@"' > $@

# ---------------------------------------------------------------------------------------------- install

# Every file of the tree $(1) is installed under $(2) with mode 0644 (the directories 0755). A symbolic link is
# installed as the file it points to (the extension holds links into src/, which would dangle in the package);
# a link that points nowhere stops the install.
define install_tree
	cd '$(1)' && find . \( -type f -o -type l \) | LC_ALL=C sort | while IFS= read -r f; do \
	    test -f "$$f" || { echo "install: $(1)/$$f is not a file or a link to one" >&2; exit 1; }; \
	    $(INSTALL) -D -m 0644 "$$f" '$(DESTDIR)$(2)'/"$$f" || exit 1; done
endef

install: all
	@test -f app/main.js || echo 'install: WARNING app/main.js is not in the tree: $(BINDIR)/$(NAME) is installed but cannot start' >&2
	@test -f $(EXT_SRC)/metadata.json || echo 'install: WARNING $(EXT_SRC)/metadata.json is not in the tree: the extension is NOT installed (empty directory)' >&2
	$(INSTALL) -d -m 0755 '$(DESTDIR)$(DATADIR)/$(NAME)/src' '$(DESTDIR)$(DATADIR)/$(NAME)/app' \
	    '$(DESTDIR)$(DATADIR)/gnome-shell/extensions/$(UUID)'
	$(call install_tree,src,$(DATADIR)/$(NAME)/src)
	@if test -d app; then $(call install_tree,app,$(DATADIR)/$(NAME)/app); fi
	@if test -d sync; then $(INSTALL) -d -m 0755 '$(DESTDIR)$(DATADIR)/$(NAME)/sync' && $(call install_tree,sync,$(DATADIR)/$(NAME)/sync); fi
	$(INSTALL) -D -m 0644 VERSION '$(DESTDIR)$(DATADIR)/$(NAME)/VERSION'
	$(INSTALL) -D -m 0755 $(BUILD)/$(NAME) '$(DESTDIR)$(BINDIR)/$(NAME)'
	$(INSTALL) -D -m 0755 $(BUILD)/$(NAME)-sync '$(DESTDIR)$(BINDIR)/$(NAME)-sync'
	$(INSTALL) -D -m 0644 data/$(NAME)-syncthing.service '$(DESTDIR)$(USERUNITDIR)/$(NAME)-syncthing.service'
	$(INSTALL) -D -m 0644 $(BUILD)/$(APP_ID).desktop '$(DESTDIR)$(DATADIR)/applications/$(APP_ID).desktop'
	$(INSTALL) -D -m 0644 $(BUILD)/$(APP_ID).metainfo.xml '$(DESTDIR)$(DATADIR)/metainfo/$(APP_ID).metainfo.xml'
	$(INSTALL) -D -m 0644 data/icons/hicolor/scalable/apps/$(APP_ID).svg \
	    '$(DESTDIR)$(DATADIR)/icons/hicolor/scalable/apps/$(APP_ID).svg'
	$(INSTALL) -D -m 0755 data/cetli-enable-extension '$(DESTDIR)$(LIBEXECDIR)/$(NAME)/enable-extension'
	$(INSTALL) -D -m 0644 $(BUILD)/$(APP_ID).enable-extension.desktop \
	    '$(DESTDIR)$(SYSCONFDIR)/xdg/autostart/$(APP_ID).enable-extension.desktop'
	$(INSTALL) -D -m 0644 $(BUILD)/$(APP_ID).autostart.desktop \
	    '$(DESTDIR)$(SYSCONFDIR)/xdg/autostart/$(APP_ID).desktop'
	@for l in $(LINGUAS); do \
	    $(INSTALL) -D -m 0644 $(BUILD)/locale/$$l/LC_MESSAGES/$(NAME).mo \
	        "$(DESTDIR)$(LOCALEDIR)/$$l/LC_MESSAGES/$(NAME).mo" || exit 1; done
	@if test -f $(EXT_SRC)/metadata.json; then \
	    $(call install_tree,$(EXT_SRC),$(DATADIR)/gnome-shell/extensions/$(UUID)) || exit 1; \
	    m='$(DESTDIR)$(DATADIR)/gnome-shell/extensions/$(UUID)/metadata.json'; \
	    if grep -q '"version-name"' "$$m"; then \
	        sed -i 's/\("version-name"[[:space:]]*:[[:space:]]*\)"[^"]*"/\1"$(VERSION)"/' "$$m"; \
	    else sed -i '0,/{/s/{/{\n  "version-name": "$(VERSION)",/' "$$m"; fi; \
	    if ls $(EXT_SRC)/schemas/*.gschema.xml >/dev/null 2>&1; then \
	        glib-compile-schemas --strict '$(DESTDIR)$(DATADIR)/gnome-shell/extensions/$(UUID)/schemas' || exit 1; \
	    fi; \
	fi

clean:
	rm -rf $(BUILD)

# ---------------------------------------------------------------------------------------------- checks

check: check-po check-po-sync check-potfiles check-version

check-po:
	@for l in $(LINGUAS); do \
	    test -f po/$$l.po || { echo "check-po: po/LINGUAS names $$l but po/$$l.po does not exist" >&2; exit 1; }; \
	    msgfmt -c --check -o /dev/null po/$$l.po || exit 1; done
	@for p in po/*.po; do l=$${p#po/}; l=$${l%.po}; \
	    echo ' $(LINGUAS) ' | grep -q " $$l " || { echo "check-po: $$p is not in po/LINGUAS" >&2; exit 1; }; done
	@$(MAKE) --no-print-directory check-potfiles
	@echo 'check-po: ok ($(LINGUAS))'

# A template made now must be fully covered by every catalog (msgcmp fails on a missing msgid).
check-po-sync:
	@tmp=$$(mktemp -d) || exit 1; \
	$(MAKE) --no-print-directory pot POT="$$tmp/$(NAME).pot" >/dev/null || { rm -rf "$$tmp"; echo 'check-po-sync: pot failed' >&2; exit 1; }; \
	rc=0; for l in $(LINGUAS); do msgcmp --use-untranslated po/$$l.po "$$tmp/$(NAME).pot" || { echo "check-po-sync: po/$$l.po differs from the template: make update-po" >&2; rc=1; }; done; \
	rm -rf "$$tmp"; test $$rc = 0 && echo 'check-po-sync: ok'

check-potfiles:
	@for f in $$(grep -rlE '$(GETTEXT_CALL)' --include='*.js' src app $(EXT_SRC) 2>/dev/null | LC_ALL=C sort); do \
	    echo ' $(POTJS) ' | grep -q " $$f " || { echo "check-potfiles: $$f has translatable strings but is not in po/POTFILES.in" >&2; exit 1; }; done; \
	echo 'check-potfiles: ok'

# .copr/Makefile writes VERSION into the Version: line of the spec it builds from, so a spec in the tree that
# lags behind is not an error for COPR; it is said here, and the %check of the spec stops a build that mixes them.
check-version:
	@spec=$$(sed -n 's/^Version:[[:space:]]*//p' packaging/fedora/$(NAME).spec | head -n 1); \
	test "$$spec" = '$(VERSION)' || echo "check-version: note: the spec in the tree says $$spec, VERSION says $(VERSION) (COPR uses VERSION)" >&2; \
	if test -f $(EXT_SRC)/metadata.json; then \
	    m=$$(sed -n 's/.*"version-name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(EXT_SRC)/metadata.json | head -n 1); \
	    test "$$m" = '$(VERSION)' || echo "check-version: note: metadata.json says version-name '$$m', install sets '$(VERSION)'" >&2; \
	fi; \
	echo 'check-version: VERSION is $(VERSION)'

check-complete:
	@miss=; for f in app/main.js sync/main.js data/$(NAME)-syncthing.service $(EXT_SRC)/metadata.json $(EXT_SRC)/extension.js; do test -f $$f || miss="$$miss $$f"; done; \
	test -z "$$miss" || { echo "check-complete: missing:$$miss" >&2; exit 1; }; echo 'check-complete: ok'
