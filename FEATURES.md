# cetli features

Short notes in small windows on the GNOME desktop (Wayland), kept in step between your computers. Version 1.0.1.

## Notes

- Each note is a small window.
- Every note is one plain file in a folder (`~/.local/share/cetli/notes/`), so you can back it up or copy it like any file.
- Create a note with the **+** button or **Ctrl+N**.
- Your text is saved as you type. There is no save button.
- Closing a note window does not delete the note; open it again from the list of all notes. Delete a note from its main menu, or from the list, which asks first.
- A note holds up to 64 KiB of text, and cetli keeps up to 500 notes.

## Look and formatting

- Nine colours in the main menu: red, yellow, pink, green, purple, blue, gray, black and white. A red note shows the title "Important". A tenth button opens a colour chooser for any other colour.
- Bold (Ctrl+B), italic (Ctrl+I), underline (Ctrl+U) and strikethrough (Ctrl+Shift+X) work on the selected text. Ctrl+Z does not undo formatting.
- Light and dark appearance follow your GNOME setting.
- Windows come back where you left them, with a small GNOME Shell extension (GNOME Shell 47 to 51).

## Finding notes

- **All notes** (Ctrl+H) lists every note as a card with its colour, time of last change and first lines, newest first.
- Search the list as you type. Click a card to open or raise the note, or use the eye button to hide and show it.

## At login

- cetli starts when you log in to GNOME and opens only the notes you had open. It opens no new empty note.
- To turn that off for your user, put a file with the same name into `~/.config/autostart` (the steps are in the README).

## Sync between computers

- Sync is optional; the notes work without it. It runs on Syncthing, and the `syncthing` program has to be installed: cetli does not install it. If it is missing, **Sync…** in the main menu shows the commands to run.
- From **Sync…**, cetli starts its own Syncthing instance for your user and shares only the notes folder.
- Connect two computers by comparing the ID each one shows. A group has up to 10 computers.
- Remove a lost computer on each of your computers; **Sync…** guides you through it. **Stop syncing** leaves all notes on every computer.
- If two computers change the same note before they meet, cetli keeps both versions.

## Language and licence

- The interface is in English and Hungarian.
- GPL-3.0-or-later. The code of this project was written with the help of AI agents.

## Not yet measured

The repository states these as not measured: a real GNOME login (autostart and where the windows land), the extension in a real GNOME Shell, and sync across ten real computers or across subnets, relays and guest Wi-Fi.
