# cetli core (P2 save layer)

Front-end independent core of the cetli sync, built to `PLAN.md` revision 5 (sha256 `aab4f66ceab4ee64...`, 79 166 bytes).
Card 9eae7c02. Licence header: `GPL-3.0-or-later` on every source (PLAN A5 default, approval still open).

## Layout

| File | Content | PLAN |
|---|---|---|
| `src/constants.js` | patterns (`UUID_RE`, `NAME_MAIN`, `NAME_CONFLICT`), limits, cause codes | 1, 2.1 |
| `src/format.js` | `classify` (V1-V11), `canon`, `V`, `cid`, order, expected copy | 1.1-1.3, 2.1, 2.2 |
| `src/store.js` | scan with cost bound, resolution, durable write, local save, own-write filter, tombstone purge, device id, layout I/O | 1.2, 1.4, 1.5, 2.2-2.6, 3, 4 (d) |
| `src/watcher.js` | event filter, 100 ms debounce, batches | 3 |
| `src/layout.js` | `layout.json` as plain data | 1.5 |
| `src/gio-layer.js` | the ONLY `gi://` module: file layer, hashes, `Gio.FileMonitor`, timers (Gio, GLib) | 1.5, 3 |
| `tests/` | headless tests (node:test), `run.sh`, `mutants.js` | |

## Seam to gjs

`store.js` and `watcher.js` get a **file layer** and a **platform** by injection (contract at the top of `store.js`). The tests use a
real-file-system layer (`tests/support/node-layer.js`); the product uses `src/gio-layer.js`. Nothing else differs.

## Run

```
tests/run.sh             # all tests on a clean copy
tests/run.sh --mutants   # + negative control
```

## First version (Peter 6649, Jenna 6644)

The conflict resolution (PLAN 2.2/2.3: copy write, deletion of conflict files) is built but NOT called: `createStore({..., resolveConflicts})` defaults to `false`. A `NAME_CONFLICT` file is kept untouched; `store.status().unresolved` counts them (the app shows "N unresolved"). Cause texts are English and not for the UI (`cause.code` is the key). Saving (2.5, incl. the copy of D before a local save) is unchanged.

Surface for the app (`src/index.js`): `createStore`, `createWatcher`, `Store` methods `start`, `refresh`, `createNote`, `saveNote`, `deleteNote`, `getNote`, `listNotes`, `status`, `newerNotes`, `onEvent`, `loadLayout`, `saveLayout`, `nextQuarantineRelease`, `purgeTombstones`; adapter `src/gio-layer.js` (`gi://` only there, never run: no gjs here).

## Choices where PLAN.md rev 5 is silent (card 9eae7c02; questions for Peter, none blocks)

- Quarantine release: `store.refresh()` releases a file whose time has come; `store.nextQuarantineRelease()` gives the instant; `watcher.js` arms ONE one-shot timer for it (replaceable: only `armRelease()`). The `<time>` in the refusal text is UTC ISO-8601 (`...Z`); no Europe/Budapest conversion in the core.
- 2.5 retry watches the file that blocked the save (`RETRY_CAUSES`): `<X>.json` for refusal (i), the copy slot for refusal (ii) and for a failed copy write (`copy not written`, as the plan says); not for `move failed` (no blocking file). [P2-T10] tested.
- PLAN 1.5 marks the durable write `H`; its premise (`CONSISTENT` fsyncs the written data) does not hold for a NEW file, and every `tmp/<uuid>.tmp` is new. The adapter therefore passes `CONSISTENT | DURABLE` (GLib doc: a target that does not exist or is empty may be left empty or full of NUL bytes after a power loss "unless DURABLE and CONSISTENT are set"). Deviation from the `H` wording of PLAN 1.5; still not measured (no gjs).
- `rev` above 1 000 000 000 and `updated` above year 2100 on a local save: refused as `REV_LIMIT` (2 small branches in `_doSave`).
- A local save is refused as `BAD_INPUT` (reason in the log) if the bytes it is about to write do not classify as VALID with our own reader (clock before year 2000, a malformed `base` such as `created: 'yesterday'`). The record is built and checked BEFORE the copy of D is written, so a refused save leaves no file behind (`REV_LIMIT`, `TOO_LARGE` included); the order of the causes is therefore: `<X>.json` state, text size, `REV_LIMIT`, `TOO_LARGE` (canonical form), `BAD_INPUT`, then the copy slot.
- Own-write filter: kept per id and applied ONLY to the main record `<id>.json` (so effectively (name, V)); a conflict file of version W is never dropped by it. The filter drops the event for the front end only, the group is evaluated in every refresh (no conflict file waits for the next event).
- Two causes at once: the order of the checks in `_doSave` (quarantine/newer/unreadable `<X>.json` first, then too large, then copy slot) is the priority; the plan has none.
- Causes for a NEWER `<X>.json`, a non-regular entry and a dangling symlink: `file needs a newer cetli` / `file not readable` (the plan names no cause for the last two); set of causes is not closed (`CAUSE`).
- `tmp/` leftovers: only `<uuid>.tmp` regular files are deleted at start; 0600 files, 0700 directories.

## NOT MEASURED (needs a real gjs / GLib / Syncthing run; P4 `%check` or Attila's machine)

`src/gio-layer.js` has never been executed (no gjs in the fleet containers). Everything that only GLib can show:
atomic `rename`, `fsync` of `GLib.file_set_contents_full`, `G_FILE_COPY_NO_FALLBACK_FOR_MOVE`, `G_IO_ERROR_NOT_SUPPORTED`,
`G_IO_ERROR_EXISTS` on a move without `OVERWRITE`, `NOFOLLOW_SYMLINKS` on a dangling link, `Gio.FileMonitor` event sequence
for a Syncthing rename, SpiderMonkey `JSON.stringify` depth limit and exception type, `TextDecoder` `fatal`/`ignoreBOM`
behaviour, GRegex `$`. The tests exercise the same rules on node's file system, which behaves like GLib where the plan says so
and differs where `tests/support/node-layer.js` says so.
