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

cetli only writes plain files to `~/.local/share/cetli/notes/`. It does not configure or start Syncthing, and there is
no automatic pairing: the pairing is done once by hand, in the stock Syncthing browser GUI. The steps below are not
tested by us on cetli [H].

1. Install Syncthing on both machines (RHEL 10: enable EPEL 10 first), start it, and open its GUI (by default
   `http://127.0.0.1:8384`) [H].
2. On each machine, copy the own device ID (Actions, Show ID) [H].
3. On machine A, add machine B as a remote device with B's device ID; do the same on B for A [H].
4. On machine A, add the folder `~/.local/share/cetli/notes/` and share it with machine B [H].
5. On machine B, accept the offered share and set its folder path to `~/.local/share/cetli/notes/` [H].

Share only the `notes/` folder; the `tmp/` folder beside it is local scratch space and does not need to be shared [H].

## Authorship

The code of this project was written with the help of AI agents.
