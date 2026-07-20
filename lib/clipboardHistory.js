import GLib from 'gi://GLib';
import St from 'gi://St';

const POLL_INTERVAL_MS = 800;
const MAX_TEXT_LENGTH = 200_000;
const HISTORY_DIRECTORY = 'quick-command';
const HISTORY_FILENAME = 'clipboard-history.json';

export class ClipboardHistory {
    constructor(settings) {
        this._settings = settings;
        this._active = true;
        this._readInFlight = false;
        this._lastClipboardText = null;
        this._changedCallback = null;
        this._clipboard = St.Clipboard.get_default();

        this._dataDirectory = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            HISTORY_DIRECTORY,
        ]);
        this._historyPath = GLib.build_filenamev([
            this._dataDirectory,
            HISTORY_FILENAME,
        ]);
        this._items = this._load();
        this._trim();

        this._settingsChangedIds = [
            this._settings.connect('changed::clipboard-enabled', () => {
                this._syncMonitoring();
            }),
            this._settings.connect('changed::clipboard-history-size', () => {
                this._trim();
                this._save();
                this._notifyChanged();
            }),
        ];

        this._syncMonitoring();
    }

    setChangedCallback(callback) {
        this._changedCallback = callback;
    }

    getItems() {
        return this._items;
    }

    copy(text) {
        if (!text)
            return;

        this._lastClipboardText = text;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this._addText(text);
    }

    clear() {
        this._items = [];
        this._save();
        this._notifyChanged();
    }

    _syncMonitoring() {
        const enabled = this._settings.get_boolean('clipboard-enabled');
        if (enabled && !this._pollSourceId) {
            this._readClipboard();
            this._pollSourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                POLL_INTERVAL_MS,
                () => {
                    this._readClipboard();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        } else if (!enabled && this._pollSourceId) {
            GLib.Source.remove(this._pollSourceId);
            this._pollSourceId = 0;
        }
    }

    _readClipboard() {
        if (!this._active || this._readInFlight)
            return;

        this._readInFlight = true;
        this._clipboard.get_text(
            St.ClipboardType.CLIPBOARD,
            (_clipboard, text) => {
                this._readInFlight = false;
                if (!this._active)
                    return;

                if (typeof text !== 'string' || !text.trim()) {
                    this._lastClipboardText = null;
                    return;
                }

                if (text === this._lastClipboardText)
                    return;

                this._lastClipboardText = text;
                this._addText(text);
            }
        );
    }

    _addText(text) {
        if (text.length > MAX_TEXT_LENGTH)
            return;

        this._items = this._items.filter(item => item.text !== text);
        this._items.unshift({
            text,
            createdAt: new Date().toISOString(),
        });
        this._trim();
        this._save();
        this._notifyChanged();
    }

    _trim() {
        const limit = this._settings.get_int('clipboard-history-size');
        this._items = this._items.slice(0, limit);
    }

    _load() {
        try {
            const [success, contents] = GLib.file_get_contents(this._historyPath);
            if (!success)
                return [];

            const parsed = JSON.parse(new TextDecoder().decode(contents));
            if (!Array.isArray(parsed))
                return [];

            return parsed.filter(item =>
                item &&
                typeof item.text === 'string' &&
                item.text.length <= MAX_TEXT_LENGTH
            );
        } catch (error) {
            if (!error.matches?.(GLib.FileError, GLib.FileError.NOENT))
                console.error(`Quick Command could not load clipboard history: ${error}`);
            return [];
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(this._dataDirectory, 0o700);
            GLib.chmod(this._dataDirectory, 0o700);
            GLib.file_set_contents(
                this._historyPath,
                JSON.stringify(this._items, null, 2)
            );
            GLib.chmod(this._historyPath, 0o600);
        } catch (error) {
            console.error(`Quick Command could not save clipboard history: ${error}`);
        }
    }

    _notifyChanged() {
        this._changedCallback?.();
    }

    destroy() {
        this._active = false;
        if (this._pollSourceId) {
            GLib.Source.remove(this._pollSourceId);
            this._pollSourceId = 0;
        }
        for (const signalId of this._settingsChangedIds)
            this._settings.disconnect(signalId);

        this._settingsChangedIds = [];
        this._changedCallback = null;
        this._clipboard = null;
        this._settings = null;
    }
}
