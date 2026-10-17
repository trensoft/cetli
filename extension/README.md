<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# cetli GNOME Shell extension (`cetli@trensoft.local`)

A Wayland client cannot place its own window. This thin extension puts each cetli note window on the rectangle
saved in `~/.local/state/cetli/layout.json` when it appears, and saves the rectangle again when the user moves or
resizes it. It draws nothing, shows no text, starts no process, uses no network, and reads and writes nothing but
that one file. GNOME Shell 47, 48, 49.

## Contract with the GTK app

- The window is the one with `gtk_application_id` (or wm class) `io.github.trensoft.cetli` **and** the title
  `cetli-<uuid>` (the note's UUID, lower case). The title must be set before the window is shown. Any other title:
  the extension does not touch the window.
- `layout.json`: `{ "<uuid>": {x, y, w, h, monitor, open} }`, validated and written with the core's
  `parseLayout` / `serializeLayout` (`layout.js`, `constants.js`). The extension writes `x y w h monitor` (`open: true`
  for a new entry, the file's value otherwise); the app owns `open`. Both sides must read the file again before every
  write and change only their own members.
- `monitor` is written as the geometry of the monitor the window is on, e.g. `1920x1080+0+0` (the connector name is
  not used: its Shell API was not checked). On restore the monitor with that key is used if it is still there, else
  the one with the largest overlap, else the primary one; the rectangle is then clamped into its work area (D3).

- The extension never makes `layout.json` bigger than the reader accepts: a save that would pass `MAX_FILE_BYTES`
  (256 KiB) is not written, and a note that is not yet in the file is not added when it already has `MAX_NOTES`
  (500) notes (the note that is in it is still updated). Each case logs one `console.warn` per session.

## Files and packaging

`layout.js` and `constants.js` in this directory are **symbolic links** to `../../src/` (one copy of the format, no
drift). The packaging must copy their content (`install`, `cp -L`), not the links. Installed to
`/usr/share/gnome-shell/extensions/cetli@trensoft.local/`: `metadata.json extension.js placement.js layout.js constants.js`.

## Text

The extension has no user-visible text of its own (nothing is drawn, no notification, no dialog), so there is no
`_()` call. The only visible strings are `name` and `description` in `metadata.json`: GNOME has no translation
mechanism for them. Messages for the journal (`console.warn` / `console.error`) are English.

## Tests

`tests/run.sh` (node >= 22): unit tests of `placement.js`, `extension.js` against fakes of Gio, GLib, Meta windows and
the layout manager, and static checks (no process, no network, only the allowed imports, file list, metadata).
**Not run in a real GNOME Shell.** Not measured: that mutter 47-49 honours `move_resize_frame` for a mapped GTK4
window (the P1 probe asked exactly this), the Gio async calls in real gjs (callback form of `query_info_async`,
`read_async`, `read_bytes_async`, `replace_contents_bytes_async`, `GLib.Bytes.toArray`), `getWorkAreaForMonitor` and
`primaryIndex` on 48 and 49, the timing of app id and title on a new window, two monitors, a locked screen.
