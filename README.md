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

## Start at login

Since 0.2.8 cetli starts by itself when you log in to GNOME and opens the notes that were open when you last left. It
opens only those: no new empty note, no list of all notes, no first-start sync window; if no note was open it opens
nothing and ends quietly. A computer whose notes folder is synchronised still gets its start-up check of the sync
program. Started by hand, cetli behaves as always.

The package installs `/etc/xdg/autostart/io.github.trensoft.cetli.desktop` (`Exec=/usr/bin/cetli --autostart`). To turn it
off for your user, put a file with the same name into `~/.config/autostart`; it overrides the system one, and an update of
the package does not touch it:

```
mkdir -p ~/.config/autostart
printf '[Desktop Entry]\nType=Application\nHidden=true\n' > ~/.config/autostart/io.github.trensoft.cetli.desktop
```

Remove that file to turn it on again. Not measured: a real GNOME login (the order of cetli and the extension, the
places of the windows after the login, what GTK does to the windows when the session ends) and whether GNOME Tweaks or
Settings show or switch this entry.

## Sync between two machines

cetli writes plain files to `~/.local/share/cetli/notes/`. Since 0.2.5 it can set up the sync itself: open the main menu and
choose **Sync…** (the window also opens once at the first start). After you press the button it starts a Syncthing instance of its
own for your user (`cetli-syncthing.service`, its own home in `~/.local/state/cetli/syncthing`, ports TCP and UDP 22100 and UDP
21127) and shares only the notes folder. It needs the `syncthing` program (RHEL 10: from EPEL 10); the window shows the commands
when it is missing and runs none of them.

To connect two computers, open **Sync…** on both. Each shows its own ID. On the waiting computer, a button accepts the computer
that knocks, after you have compared the ID shown there with the ID on the other computer (compare at least the first two
groups); or type the ID of the other computer into the field. The window says *Connected* only when the program has proof from
the other computer's side.
If the sync program does not answer (it hangs, or its unit is not running: inactive, failed, start limit), the window starts it again by itself, once per opening, without a click. A unit that was switched off with `cetli-sync forget --all --stop` (disabled) is NOT started by itself: the error window then offers the button, which switches it on (`enable --now`). If that does not help, the error window offers **Try again** (starts the sync program again, touches no data) and **Reset sync** (after a
confirmation: moves the own directory of the sync program aside under a time-stamped name, takes away the marker of cetli's own folder, and starts again at the
ID page with a new ID; no note is touched; the other computers must remove this computer or stop syncing too). The moved-aside directory (`~/.local/state/cetli/syncthing.bak-<time>`) still holds the old private key and the old settings of the sync program: delete it by hand when you do not need it any more; cetli never deletes it. On the command line: `cetli-sync restart [--enable]`, `cetli-sync reset`, `cetli-sync ensure` (the quiet check cetli runs once when it starts on a synchronised computer: it starts the sync program only when it is stopped and its unit is enabled, and does nothing otherwise). A restart that ends on a config that is not what cetli wrote (a dead end) offers **Reset sync** as well.

Since 0.2.7 a group has up to 10 computers. To add a computer, open **Sync…** on any computer of the group, press **Add a
computer** and accept the one that knocks; the new computer types the ID of that computer. The other computers learn the new one by
themselves. A computer you accept can add other computers to your group without asking you again. Remove a lost computer on all
your computers. **Sync…** shows how each computer came into the group and guides you through the removal, and it never claims that a
computer is removed from the whole group, only from the one it runs on. If you paired computers with 0.2.5, open **Sync…** on each of
them and allow the new rule once: a pair works under the new rule only when it is allowed on both of its computers. A computer you removed
is not offered again when it knocks; **Add again** in **Sync…** lifts that, and you still compare its ID and accept it. **Stop syncing** removes all other computers and their shares; it never removes the folder or a
note. Going back to 0.2.5 needs **Stop syncing** first.

What is measured and what is not (see the changelog in `packaging/fedora/cetli.spec`): measured with 10 computers in one group on one shared
local network (a virtual LAN on one machine; 2 of them ran the real application, 8 only the sync engine): the computers joined one by one, a
note from each computer reached the other 9, and the 11th computer was refused. A removal given on one computer only did not reach the others
within 85 s; after it was given on 6 of the 9 remaining computers, none of them listed it any more (on the other 3 the call answered
E_BAD_ID). A note from one computer then reached the other 8. Earlier runs
with up to 4 Syncthing instances and with two real instances: with local discovery the computers connect to each other directly within a second
or two; without local discovery nothing connects. Not measured: 10 real computers, another subnet, a VLAN, a guest or client-isolated WiFi,
NAT, relays, a real RHEL 10 session. There the computers may connect through the first computer only, or not at all. A computer whose notes folder is already
synchronised by a Syncthing you set up by hand is left exactly as it is.

## Authorship

The code of this project was written with the help of AI agents.
