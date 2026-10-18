# cetli

Short notes in small windows on the GNOME desktop (Wayland). Every note is one plain file in a folder, so the
folder can be kept in step between computers with a tool such as Syncthing. A GNOME Shell extension puts the
note windows back where they were.

License: GPL-3.0-or-later. Version: see `VERSION`.

## Install

From COPR (once the project `trensoft/cetli` exists):

```
sudo dnf copr enable trensoft/cetli
sudo dnf install cetli
```

Log out and in once, so that GNOME Shell finds the extension. The package recommends `syncthing` and does not set it
up. On RHEL 10 / CentOS Stream 10 `syncthing` comes from EPEL 10; the notes work without it.

## Sync between two machines

cetli writes plain files to `~/.local/share/cetli/notes/`. Since 0.2.5 it can set up the sync itself: open the main menu and
choose **Sync…** (the window also opens once at the first start). After you press the button it starts a Syncthing instance of its
own for your user (`cetli-syncthing.service`, its own home in `~/.local/state/cetli/syncthing`, ports TCP and UDP 22100 and UDP
21127) and shares only the notes folder. It needs the `syncthing` program (RHEL 10: from EPEL 10); the window shows the commands
when it is missing and runs none of them.

To connect two computers, open **Sync…** on both. Each shows its own ID. On the waiting computer, a button accepts the computer
that knocks, after you have compared the ID shown there with the ID on the other computer (compare at least the first two
groups); or type the ID of the other computer into the field. The window says *Connected* only when the program has proof from
the other computer's side. **Stop syncing** removes the other computer and its share; it never removes the folder or a note.
If the sync program does not answer (it hangs, or its unit is not running: inactive, failed, start limit), the window starts it again by itself, once per opening, without a click. A unit that was switched off with `cetli-sync forget --stop` (disabled) is NOT started by itself: the error window then offers the button, which switches it on (`enable --now`). If that does not help, the error window offers **Try again** (starts the sync program again, touches no data) and **Reset sync** (after a
confirmation: moves the own directory of the sync program aside under a time-stamped name, takes away the marker of cetli's own folder, and starts again at the
ID page with a new ID; no note is touched; the other computer must stop syncing too). The moved-aside directory (`~/.local/state/cetli/syncthing.bak-<time>`) still holds the old private key and the old settings of the sync program: delete it by hand when you do not need it any more; cetli never deletes it. On the command line: `cetli-sync restart [--enable]`, `cetli-sync reset`. A restart that ends on a config that is not what cetli wrote (a dead end) offers **Reset sync** as well.

What is measured and what is not (see the changelog in `packaging/fedora/cetli.spec`): two computers are the supported case.
cetli pairs a computer with exactly one other computer; three or more cannot be set up in this version. Not measured: a real network behind a default firewall or NAT,
relays, a real RHEL 10 session. A computer whose notes folder is already synchronised by a Syncthing you set up by hand is
left exactly as it is.

## Authorship

The code of this project was written with the help of AI agents.
