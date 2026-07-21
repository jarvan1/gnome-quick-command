import GLib from 'gi://GLib';
import St from 'gi://St';

const POLL_INTERVAL_MS = 800;
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
        this._lastClipboardSignature = null;
        this._changedCallback = null;
        this._clipboard = St.Clipboard.get_default();

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
            this._save();

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
                this._save();
                this._notifyChanged();
            }),
        ];

        this._expirySourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            EXPIRY_CHECK_INTERVAL_SECONDS,
            () => {
                if (this._trim()) {
                    this._save();
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
        this._addText(text);
        return true;
    }

    copyItem(item) {
        if (item?.type !== 'image')
            return this.copy(item?.text);

        const imagePath = this.getImagePath(item);
        if (!imagePath)
            return false;

        try {
            const [success, contents] = GLib.file_get_contents(imagePath);
            if (!success)
                return false;

            const bytes = GLib.Bytes.new(contents);
            this._lastClipboardSignature = `image:${item.checksum}`;
            this._clipboard.set_content(
                St.ClipboardType.CLIPBOARD,
                item.mimeType,
                bytes
            );
            this._items = this._items.filter(candidate =>
                candidate.type !== 'image' || candidate.filename !== item.filename
            );
            this._items.unshift({...item, createdAt: new Date().toISOString()});
            this._trim();
            this._save();
            this._notifyChanged();
            return true;
        } catch (error) {
            console.error(`Quick Command could not restore clipboard image: ${error}`);
            return false;
        }
    }

    clear() {
        const removedItems = this._items;
        this._items = [];
        this._deleteRemovedImages(removedItems);
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
        if (!this._active || this._readInFlight ||
            !this._settings.get_boolean('clipboard-enabled'))
            return;

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
                    this._readInFlight = false;
                    if (!this._active || !bytes)
                        return;
                    this._captureImage(bytes, imageMime);
                }
            );
            return;
        }

        this._clipboard.get_text(
            St.ClipboardType.CLIPBOARD,
            (_clipboard, text) => {
                this._readInFlight = false;
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
                this._addText(text);
            }
        );
    }

    _captureImage(bytes, imageMime) {
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
            createdAt: new Date().toISOString(),
        });
        this._trim();
        this._save();
        this._notifyChanged();
    }

    _addText(text) {
        if (text.length > MAX_TEXT_LENGTH)
            return;

        this._items = this._items.filter(item =>
            item.type === 'image' || item.text !== text
        );
        this._items.unshift({
            type: 'text',
            text,
            createdAt: new Date().toISOString(),
        });
        this._trim();
        this._save();
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

        const removedItems = this._items.filter(item =>
            !retainedItems.includes(item)
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
                if (imagePath && GLib.file_test(imagePath, GLib.FileTest.IS_REGULAR))
                    items.push(item);
            }
            return items;
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
        if (this._expirySourceId) {
            GLib.Source.remove(this._expirySourceId);
            this._expirySourceId = 0;
        }
        for (const signalId of this._settingsChangedIds)
            this._settings.disconnect(signalId);

        this._settingsChangedIds = [];
        this._changedCallback = null;
        this._clipboard = null;
        this._settings = null;
    }
}
