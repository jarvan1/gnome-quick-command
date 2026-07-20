# Quick Command

Quick Command is a small command palette for GNOME Shell. The first version
focuses on three jobs:

- open a centered launcher with a configurable global shortcut;
- discover, search, and launch installed desktop applications;
- capture, search, and directly paste plain-text clipboard history.

The extension targets GNOME Shell 45 and newer. It is developed against GNOME
Shell 46 on Ubuntu 24.04.

## Install from source

```bash
make install
gnome-extensions enable quick-command@xinming.local
```

On a Wayland session, log out and back in if GNOME Shell does not discover a
newly installed extension. On X11, `Alt+F2`, then `r`, can reload the shell.
GNOME Shell 45 and newer also cache extension JavaScript modules, so log out
and back in after updating the extension source; disabling and enabling alone
does not load changed modules.

Press `Ctrl+Alt+Space` to open Quick Command. Type to filter applications, use the
arrow keys to select a result, and press Enter to launch it. Chinese application
names support native text, full pinyin, and initials (for example `终端`,
`zhongduan`, or `zd`). Press Tab to switch
between applications and clipboard history. Activating a clipboard result pastes
it into the previously focused application; common terminals use
`Ctrl+Shift+V` automatically.

Open Extension Manager or run the following command to change settings:

```bash
gnome-extensions prefs quick-command@xinming.local
```

The shortcut field uses GTK accelerator syntax, such as `<Super>r` or
`<Ctrl>space`.

## Clipboard storage and privacy

Clipboard text is saved to:

```text
~/.local/share/quick-command/clipboard-history.json
```

The directory and file are created with user-only permissions. The current
version records all non-empty text up to 200,000 characters, so disable
clipboard history before copying passwords, access tokens, or other sensitive
content. Image clipboard support is intentionally deferred to a native helper
instead of being mixed into the Shell UI process.

The bundled pinyin table is generated from the standard Rime single-character
table; the installed extension does not require Rime or an input method to be
enabled.

## Development checks

```bash
glib-compile-schemas --strict --dry-run schemas
make build
```

Inspect runtime errors with:

```bash
journalctl --user -f -o cat | rg 'Quick Command|quick-command'
```
