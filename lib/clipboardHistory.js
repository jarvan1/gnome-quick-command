import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

const SAVE_DEBOUNCE_MS = 2000;
const EXPIRY_CHECK_INTERVAL_SECONDS = 60 * 60;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 200_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_STORAGE_BYTES = 200 * 1024 * 1024;
const HISTORY_DIRECTORY = 'quick-command';
const HISTORY_FILENAME = 'clipboard-history.json';
const IMAGE_DIRECTORY = 'images';
const IMAGE_MIME_TYPES = [
    {mimeType: 'image/png', extension: 'png'},
    {mimeType: 'image/jpeg', extension: 'jpg'},
    {mimeType: 'image/webp', extension: 'webp'},
    {mimeType: 'image/bmp', extension: 'bmp'},
    {mimeType: 'image/x-ms-bmp', extension: 'bmp'},
];

function findImageMimeType(mimetypes) {
    const offeredTypes = new Map((mimetypes ?? []).map(mimetype => [
        mimetype.toLocaleLowerCase().split(';', 1)[0],
        mimetype,
    ]));

    for (const definition of IMAGE_MIME_TYPES) {
        const offeredMimeType = offeredTypes.get(definition.mimeType);
        if (offeredMimeType)
            return {...definition, offeredMimeType};
    }
    return null;
}

function isSafeImageFilename(filename) {
    return typeof filename === 'string' &&
        /^[a-f0-9]{64}\.(?:png|jpg|webp|bmp)$/.test(filename);
}

function isSupportedImageItem(item) {
    return /^[a-f0-9]{64}$/.test(item.checksum) &&
        item.filename.startsWith(`${item.checksum}.`) &&
        IMAGE_MIME_TYPES.some(definition =>
            definition.mimeType === item.mimeType &&
            item.filename.endsWith(`.${definition.extension}`)
        );
}

export class ClipboardHistory {
    constructor(settings) {
        this._settings = settings;
        this._active = true;
        this._readInFlight = false;
        this._readAgain = false;
        this._lastClipboardSignature = null;
        this._changedCallback = null;
        this._clipboard = St.Clipboard.get_default();
        this._windowTracker = Shell.WindowTracker.get_default();
        this._selection = global.display.get_selection();
        this._selectionOwnerChangedId = 0;
        this._saveSourceId = 0;
        this._saveInFlight = false;
        this._saveCancellable = new Gio.Cancellable();
        this._dirty = false;

        this._dataDirectory = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            HISTORY_DIRECTORY,
        ]);
        this._imageDirectory = GLib.build_filenamev([
            this._dataDirectory,
            IMAGE_DIRECTORY,
        ]);
        this._historyPath = GLib.build_filenamev([
            this._dataDirectory,
            HISTORY_FILENAME,
        ]);
        this._items = this._load();
        if (this._trim())
            this._scheduleSave();

        this._settingsChangedIds = [
            this._settings.connect('changed::clipboard-enabled', () => {
                this._syncMonitoring();
            }),
            this._settings.connect('changed::clipboard-images-enabled', () => {
                this._lastClipboardSignature = null;
                this._readClipboard();
            }),
            this._settings.connect('changed::clipboard-history-size', () => {
                this._trim();
                this._scheduleSave();
                this._notifyChanged();
            }),
        ];

        this._expirySourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            EXPIRY_CHECK_INTERVAL_SECONDS,
            () => {
                if (this._trim()) {
                    this._scheduleSave();
                    this._notifyChanged();
                }
                return GLib.SOURCE_CONTINUE;
            }
        );
        this._syncMonitoring();
    }

    setChangedCallback(callback) {
        this._changedCallback = callback;
    }

    getItems() {
        return this._items;
    }

    getImagePath(item) {
        if (item?.type !== 'image' || !isSafeImageFilename(item.filename))
            return null;
        return GLib.build_filenamev([this._imageDirectory, item.filename]);
    }

    copy(text) {
        if (!text)
            return false;

        this._lastClipboardSignature = `text:${text}`;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this._addText(text, this._getClipboardSource());
        return true;
    }

    copyItem(item) {
        if (item?.type !== 'image') {
            if (typeof item?.text !== 'string' || !item.text)
                return false;

            this._lastClipboardSignature = `text:${item.text}`;
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.text);
            this._items = this._items.filter(candidate =>
                candidate.type === 'image' || candidate.text !== item.text
            );
            this._items.unshift({...item, createdAt: new Date().toISOString()});
            this._trim();
            this._scheduleSave();
            this._notifyChanged();
            return true;
        }

        const imagePath = this.getImagePath(item);
        if (!imagePath ||
            !GLib.file_test(imagePath, GLib.FileTest.IS_REGULAR))
            return false;

        this._lastClipboardSignature = `image:${item.checksum}`;
        Gio.File.new_for_path(imagePath).load_bytes_async(
            null,
            (file, result) => {
                if (!this._active)
                    return;
                try {
                    const [bytes] = file.load_bytes_finish(result);
                    this._clipboard.set_content(
                        St.ClipboardType.CLIPBOARD,
                        item.mimeType,
                        bytes
                    );
                } catch (error) {
                    console.error(`Quick Command could not restore clipboard image: ${error}`);
                }
            }
        );
        this._items = this._items.filter(candidate =>
            candidate.type !== 'image' || candidate.filename !== item.filename
        );
        this._items.unshift({...item, createdAt: new Date().toISOString()});
        this._trim();
        this._scheduleSave();
        this._notifyChanged();
        return true;
    }

    deleteItem(item) {
        const remainingItems = this._items.filter(candidate =>
            candidate !== item
        );
        if (remainingItems.length === this._items.length)
            return false;

        this._items = remainingItems;
        this._deleteRemovedImages([item]);
        this._scheduleSave();
        this._notifyChanged();
        return true;
    }

    clear() {
        const removedItems = this._items;
        this._items = [];
        this._deleteRemovedImages(removedItems);
        this._scheduleSave();
        this._notifyChanged();
    }

    _syncMonitoring() {
        const enabled = this._settings.get_boolean('clipboard-enabled');
        if (enabled && !this._selectionOwnerChangedId) {
            this._selectionOwnerChangedId = this._selection.connect(
                'owner-changed',
                (_selection, selectionType) => {
                    if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD)
                        this._readClipboard();
                }
            );
            this._readClipboard();
        } else if (!enabled && this._selectionOwnerChangedId) {
            this._selection.disconnect(this._selectionOwnerChangedId);
            this._selectionOwnerChangedId = 0;
        }
    }

    _readClipboard() {
        if (!this._active || !this._settings.get_boolean('clipboard-enabled'))
            return;

        if (this._readInFlight) {
            this._readAgain = true;
            return;
        }

        const source = this._getClipboardSource();
        let imageMime = null;
        if (this._settings.get_boolean('clipboard-images-enabled')) {
            try {
                imageMime = findImageMimeType(this._clipboard.get_mimetypes(
                    St.ClipboardType.CLIPBOARD
                ));
            } catch (error) {
                console.error(`Quick Command could not inspect clipboard formats: ${error}`);
            }
        }

        this._readInFlight = true;
        if (imageMime) {
            this._clipboard.get_content(
                St.ClipboardType.CLIPBOARD,
                imageMime.offeredMimeType,
                (_clipboard, bytes) => {
                    this._finishRead();
                    if (!this._active || !bytes)
                        return;
                    this._captureImage(bytes, imageMime, source);
                }
            );
            return;
        }

        this._clipboard.get_text(
            St.ClipboardType.CLIPBOARD,
            (_clipboard, text) => {
                this._finishRead();
                if (!this._active)
                    return;

                if (typeof text !== 'string' || !text.trim()) {
                    this._lastClipboardSignature = null;
                    return;
                }

                const signature = `text:${text}`;
                if (signature === this._lastClipboardSignature)
                    return;

                this._lastClipboardSignature = signature;
                this._addText(text, source);
            }
        );
    }

    _finishRead() {
        this._readInFlight = false;
        if (this._readAgain) {
            this._readAgain = false;
            this._readClipboard();
        }
    }

    _captureImage(bytes, imageMime, source = null) {
        const byteSize = bytes.get_size();
        if (byteSize <= 0)
            return;

        const checksum = GLib.compute_checksum_for_bytes(
            GLib.ChecksumType.SHA256,
            bytes
        );
        const signature = `image:${checksum}`;
        if (signature === this._lastClipboardSignature)
            return;

        this._lastClipboardSignature = signature;
        if (byteSize > MAX_IMAGE_BYTES)
            return;

        const filename = `${checksum}.${imageMime.extension}`;
        const imagePath = GLib.build_filenamev([this._imageDirectory, filename]);

        try {
            GLib.mkdir_with_parents(this._imageDirectory, 0o700);
            GLib.chmod(this._dataDirectory, 0o700);
            GLib.chmod(this._imageDirectory, 0o700);
            if (!GLib.file_test(imagePath, GLib.FileTest.IS_REGULAR))
                GLib.file_set_contents(imagePath, bytes.get_data());
            GLib.chmod(imagePath, 0o600);
        } catch (error) {
            console.error(`Quick Command could not save clipboard image: ${error}`);
            return;
        }

        this._items = this._items.filter(item =>
            item.type !== 'image' || item.checksum !== checksum
        );
        this._items.unshift({
            type: 'image',
            filename,
            checksum,
            mimeType: imageMime.mimeType,
            byteSize,
            source,
            createdAt: new Date().toISOString(),
        });
        this._trim();
        this._scheduleSave();
        this._notifyChanged();
    }

    _addText(text, source = null) {
        if (text.length > MAX_TEXT_LENGTH)
            return;

        this._items = this._items.filter(item =>
            item.type === 'image' || item.text !== text
        );
        this._items.unshift({
            type: 'text',
            text,
            byteSize: new TextEncoder().encode(text).byteLength,
            source,
            createdAt: new Date().toISOString(),
        });
        this._trim();
        this._scheduleSave();
        this._notifyChanged();
    }

    _trim() {
        const limit = this._settings.get_int('clipboard-history-size');
        const cutoff = Date.now() - HISTORY_RETENTION_MS;
        const countLimitedItems = this._items
            .filter(item => {
                const createdAt = Date.parse(item.createdAt);
                return Number.isFinite(createdAt) && createdAt >= cutoff;
            })
            .slice(0, limit);
        const retainedItems = [];
        let imageStorageBytes = 0;

        for (const item of countLimitedItems) {
            if (item.type === 'image') {
                if (imageStorageBytes + item.byteSize > MAX_IMAGE_STORAGE_BYTES)
                    continue;
                imageStorageBytes += item.byteSize;
            }
            retainedItems.push(item);
        }

        const retainedSet = new Set(retainedItems);
        const removedItems = this._items.filter(item =>
            !retainedSet.has(item)
        );
        const changed = removedItems.length > 0;
        this._items = retainedItems;
        this._deleteRemovedImages(removedItems);
        return changed;
    }

    _deleteRemovedImages(removedItems) {
        const retainedFilenames = new Set(this._items
            .filter(item => item.type === 'image')
            .map(item => item.filename));

        for (const item of removedItems) {
            if (item.type !== 'image' || retainedFilenames.has(item.filename))
                continue;
            const imagePath = this.getImagePath(item);
            if (imagePath)
                GLib.unlink(imagePath);
        }
    }

    _load() {
        try {
            const [success, contents] = GLib.file_get_contents(this._historyPath);
            if (!success)
                return [];

            const parsed = JSON.parse(new TextDecoder().decode(contents));
            if (!Array.isArray(parsed))
                return [];

            const items = [];
            for (const item of parsed) {
                if (!item)
                    continue;

                if ((item.type === 'text' || item.type === undefined) &&
                    typeof item.text === 'string' &&
                    item.text.length <= MAX_TEXT_LENGTH) {
                    items.push({
                        type: 'text',
                        text: item.text,
                        byteSize: Number.isSafeInteger(item.byteSize) &&
                            item.byteSize >= 0
                            ? item.byteSize
                            : new TextEncoder().encode(item.text).byteLength,
                        source: typeof item.source === 'string' &&
                            item.source.length <= 200
                            ? item.source
                            : null,
                        createdAt: item.createdAt,
                    });
                    continue;
                }

                if (item.type !== 'image' ||
                    !isSafeImageFilename(item.filename) ||
                    typeof item.checksum !== 'string' ||
                    typeof item.mimeType !== 'string' ||
                    !isSupportedImageItem(item) ||
                    !Number.isSafeInteger(item.byteSize) ||
                    item.byteSize <= 0 || item.byteSize > MAX_IMAGE_BYTES)
                    continue;

                const imagePath = this.getImagePath(item);
                if (imagePath && GLib.file_test(imagePath, GLib.FileTest.IS_REGULAR)) {
                    items.push({
                        ...item,
                        source: typeof item.source === 'string' &&
                            item.source.length <= 200
                            ? item.source
                            : null,
                    });
                }
            }
            return items;
        } catch (error) {
            if (!error.matches?.(GLib.FileError, GLib.FileError.NOENT))
                console.error(`Quick Command could not load clipboard history: ${error}`);
            return [];
        }
    }

    _ensureDataDirectory() {
        GLib.mkdir_with_parents(this._dataDirectory, 0o700);
        GLib.chmod(this._dataDirectory, 0o700);
    }

    _scheduleSave() {
        this._dirty = true;
        if (this._saveSourceId)
            return;
        this._saveSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SAVE_DEBOUNCE_MS,
            () => {
                this._saveSourceId = 0;
                this._save();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _save() {
        if (!this._dirty || this._saveInFlight)
            return;

        this._dirty = false;
        let bytes;
        try {
            this._ensureDataDirectory();
            bytes = new GLib.Bytes(new TextEncoder().encode(
                JSON.stringify(this._items)
            ));
        } catch (error) {
            console.error(`Quick Command could not save clipboard history: ${error}`);
            return;
        }

        this._saveInFlight = true;
        Gio.File.new_for_path(this._historyPath).replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE,
            this._saveCancellable,
            (file, result) => {
                this._saveInFlight = false;
                try {
                    file.replace_contents_finish(result);
                    GLib.chmod(this._historyPath, 0o600);
                } catch (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`Quick Command could not save clipboard history: ${error}`);
                }
                if (this._active && this._dirty && !this._saveSourceId)
                    this._save();
            }
        );
    }

    _saveSync() {
        if (!this._dirty)
            return;

        this._dirty = false;
        try {
            this._ensureDataDirectory();
            GLib.file_set_contents(
                this._historyPath,
                JSON.stringify(this._items)
            );
            GLib.chmod(this._historyPath, 0o600);
        } catch (error) {
            console.error(`Quick Command could not save clipboard history: ${error}`);
        }
    }

    _notifyChanged() {
        this._changedCallback?.();
    }

    _getClipboardSource() {
        const window = global.display.focus_window;
        if (!window)
            return null;

        const appName = this._windowTracker.get_window_app(window)?.get_name();
        if (appName)
            return appName.slice(0, 200);

        const identifier = window.get_wm_class?.() ??
            window.get_gtk_application_id?.() ??
            null;
        return identifier?.slice(0, 200) ?? null;
    }

    destroy() {
        this._active = false;
        if (this._selectionOwnerChangedId) {
            this._selection.disconnect(this._selectionOwnerChangedId);
            this._selectionOwnerChangedId = 0;
        }
        if (this._expirySourceId) {
            GLib.Source.remove(this._expirySourceId);
            this._expirySourceId = 0;
        }
        if (this._saveSourceId) {
            GLib.Source.remove(this._saveSourceId);
            this._saveSourceId = 0;
        }
        this._saveCancellable.cancel();
        if (this._saveInFlight) {
            // The cancelled write held the only copy of its snapshot; force a
            // final synchronous write so nothing is lost.
            this._dirty = true;
        }
        this._saveSync();
        for (const signalId of this._settingsChangedIds)
            this._settings.disconnect(signalId);

        this._settingsChangedIds = [];
        this._changedCallback = null;
        this._clipboard = null;
        this._windowTracker = null;
        this._selection = null;
        this._settings = null;
    }
}
