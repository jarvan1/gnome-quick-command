import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isTerminalWindow, PasteController} from './pasteController.js';

const MAX_RESULT_ITEMS = 100;
const PANEL_MIN_WIDTH = 820;
const PANEL_MAX_WIDTH = 1080;
const PANEL_MIN_HEIGHT = 560;
const PANEL_MAX_HEIGHT = 760;
const PANEL_FIXED_CONTENT_HEIGHT = 184;
const MODE_APPS = 'apps';
const MODE_CLIPBOARD = 'clipboard';
// Shell.BlurEffect paints a rectangle with no rounded-corner clipping, so
// the blur is applied to a bed actor inset far enough that the rectangle
// stays inside the panel's 12px rounded outline: 12 × (1 − 1/√2) ≈ 3.5px.
const PANEL_BLUR_INSET = 4;

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function compactText(text, maxLength = 110) {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxLength)
        return singleLine;
    return `${singleLine.slice(0, maxLength - 1)}…`;
}

// `normalizedQuery` must already be NFKC-normalized and lowercased.
function clipboardMatches(item, normalizedQuery, imageKeywords) {
    if (!normalizedQuery)
        return true;
    const searchableText = item.type === 'image'
        ? `${imageKeywords} ${item.mimeType} ${item.source ?? ''}`
        : `${item.text} ${item.source ?? ''} text/plain`;
    return searchableText.normalize('NFKC').toLocaleLowerCase()
        .includes(normalizedQuery);
}

function formatBytes(byteSize) {
    if (byteSize < 1024)
        return `${byteSize} B`;
    if (byteSize < 1024 * 1024)
        return `${Math.round(byteSize / 1024)} KB`;
    return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function imageTitle(item, imageLabel) {
    const format = item.mimeType.split('/')[1]?.toLocaleUpperCase() ?? 'IMAGE';
    return `${imageLabel} · ${format} · ${formatBytes(item.byteSize)}`;
}

function clipboardGroup(createdAt, now = new Date()) {
    if (Number.isNaN(createdAt.getTime()))
        return 'Earlier';

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const weekStart = new Date(today);
    const dayFromMonday = (today.getDay() + 6) % 7;
    weekStart.setDate(today.getDate() - dayFromMonday);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    if (createdAt >= today)
        return 'Today';
    if (createdAt >= yesterday)
        return 'Yesterday';
    if (createdAt >= weekStart)
        return 'This Week';
    if (createdAt >= monthStart)
        return 'This Month';
    return 'Earlier';
}

// St.TextureCache forces the content's preferred size to the requested
// width × height (st_image_content_new_with_preferred_size) and shares
// in-flight requests by file only, so the actor's natural size cannot be
// trusted to match the image's aspect ratio. Compute a fitted size from
// the image header ourselves (never upscaling), then pin the actor to it
// with RESIZE_ASPECT gravity so the pixels can never be distorted.
function fitImageDimensions(imagePath, maxWidth, maxHeight) {
    const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(imagePath);
    if (!format || width <= 0 || height <= 0)
        return [maxWidth, maxHeight];

    const scale = Math.min(maxWidth / width, maxHeight / height, 1);
    return [
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)),
    ];
}

function textByteSize(item) {
    if (Number.isSafeInteger(item.byteSize))
        return item.byteSize;
    return new TextEncoder().encode(item.text ?? '').byteLength;
}

export const QuickCommandDialog = GObject.registerClass(
class QuickCommandDialog extends ModalDialog.ModalDialog {
    _init(appIndex, clipboardHistory, settings, translate = text => text) {
        super._init({
            styleClass: 'quick-command-modal',
            destroyOnClose: false,
        });

        this._appIndex = appIndex;
        this._clipboardHistory = clipboardHistory;
        this._settings = settings;
        this._ = translate;
        this._blurEffect = null;
        this._mode = MODE_APPS;
        this._selectedIndex = 0;
        this._visibleItems = [];
        this._reopenAfterClose = false;
        this._destroying = false;
        this._opening = false;
        this._pendingPaste = null;
        this._pasteWithShift = false;
        this._pasteTargetWindow = null;
        this._pasteController = new PasteController();

        this._buildUi();
        this._blurChangedId = this._settings.connect(
            'changed::blur-enabled',
            () => this._syncBlur()
        );
        this._syncBlur();
        this.setInitialKeyFocus(this._entry);
        this.connect('closed', () => {
            if (!this._destroying && this._pendingPaste !== null) {
                const pendingPaste = this._pendingPaste;
                this._pendingPaste = null;
                this._pasteController.paste(
                    pendingPaste.content,
                    pendingPaste.targetWindow,
                    pendingPaste.useShift
                );
            }
            if (!this._destroying && this._reopenAfterClose) {
                this._reopenAfterClose = false;
                this.showLauncher();
            }
        });
    }

    _buildUi() {
        // Panel and blur bed overlap in a BinLayout: the bed sits behind
        // the panel and carries the background blur (see PANEL_BLUR_INSET).
        this._wrapper = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this._blurBed = new St.Widget({
            style_class: 'quick-command-blur-bed',
            x_expand: true,
            y_expand: true,
            margin_top: PANEL_BLUR_INSET,
            margin_bottom: PANEL_BLUR_INSET,
            margin_left: PANEL_BLUR_INSET,
            margin_right: PANEL_BLUR_INSET,
        });
        this._wrapper.add_child(this._blurBed);

        this._panel = new St.BoxLayout({
            style_class: 'quick-command-panel',
            vertical: true,
            x_expand: true,
        });
        this._wrapper.add_child(this._panel);
        this.contentLayout.add_child(this._wrapper);

        this._entry = new St.Entry({
            style_class: 'quick-command-search-entry',
            hint_text: this._('Search applications…'),
            primary_icon: new St.Icon({
                style_class: 'quick-command-search-icon',
                icon_name: 'system-search-symbolic',
                icon_size: 20,
            }),
            can_focus: true,
            x_expand: true,
        });
        this._panel.add_child(this._entry);

        this._entry.clutter_text.connect('text-changed', () => {
            this._selectedIndex = 0;
            this._refresh();
        });
        this._entry.clutter_text.connect(
            'key-press-event',
            (_actor, event) => this._onKeyPressed(event)
        );

        this._panel.add_child(new St.Widget({
            style_class: 'quick-command-separator',
            x_expand: true,
        }));

        const tabs = new St.BoxLayout({
            style_class: 'quick-command-tabs',
            x_expand: true,
        });
        this._appTab = this._createTab(this._('Applications'), MODE_APPS);
        this._clipboardTab = this._createTab(
            this._('Clipboard'),
            MODE_CLIPBOARD
        );
        tabs.add_child(this._appTab);
        tabs.add_child(this._clipboardTab);

        this._clearButton = new St.Button({
            style_class: 'quick-command-clear-button',
            label: this._('Clear History'),
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            can_focus: true,
        });
        this._clearButton.connect('clicked', () => this._clipboardHistory.clear());
        tabs.add_child(this._clearButton);
        this._panel.add_child(tabs);

        this._resultsScrollView = new St.ScrollView({
            style_class: 'quick-command-results-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            enable_mouse_scrolling: true,
            x_expand: true,
            y_expand: true,
        });
        this._resultsBox = new St.BoxLayout({
            style_class: 'quick-command-results',
            vertical: true,
            x_expand: true,
        });
        this._resultsScrollView.set_child(this._resultsBox);
        this._panel.add_child(this._resultsScrollView);

        this._clipboardWorkspace = new St.BoxLayout({
            style_class: 'quick-command-clipboard-workspace',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });

        this._clipboardListScrollView = new St.ScrollView({
            style_class: 'quick-command-clipboard-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            enable_mouse_scrolling: true,
        });
        this._clipboardListBox = new St.BoxLayout({
            style_class: 'quick-command-clipboard-list',
            vertical: true,
            x_expand: true,
        });
        this._clipboardListScrollView.set_child(this._clipboardListBox);
        this._clipboardWorkspace.add_child(this._clipboardListScrollView);

        this._clipboardDetails = new St.BoxLayout({
            style_class: 'quick-command-clipboard-details',
            vertical: true,
            x_expand: true,
        });
        this._clipboardPreviewScrollView = new St.ScrollView({
            style_class: 'quick-command-clipboard-preview-scroll',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            enable_mouse_scrolling: true,
            x_expand: true,
            y_expand: true,
        });
        this._clipboardPreviewBox = new St.BoxLayout({
            style_class: 'quick-command-clipboard-preview',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._clipboardPreviewScrollView.set_child(this._clipboardPreviewBox);
        this._clipboardDetails.add_child(this._clipboardPreviewScrollView);

        this._clipboardInfoBox = new St.BoxLayout({
            style_class: 'quick-command-clipboard-info',
            vertical: true,
            x_expand: true,
        });
        this._clipboardDetails.add_child(this._clipboardInfoBox);
        this._clipboardWorkspace.add_child(this._clipboardDetails);
        this._panel.add_child(this._clipboardWorkspace);

        // Mode-dependent hints sit in a left group and the constant hints
        // in a right-aligned group, so toggling the delete hint or swapping
        // the action label never shifts the rest of the footer.
        const footer = new St.BoxLayout({
            style_class: 'quick-command-footer',
            x_expand: true,
        });
        const footerLeft = new St.BoxLayout({
            style_class: 'quick-command-footer-group',
        });
        const [actionHintBox, actionHintLabel] =
            this._createFooterHint('↵', this._('Open'));
        this._actionHint = actionHintLabel;
        footerLeft.add_child(actionHintBox);
        this._deleteHint =
            this._createFooterHint('Ctrl+Del', this._('Delete'))[0];
        footerLeft.add_child(this._deleteHint);
        footer.add_child(footerLeft);

        const footerRight = new St.BoxLayout({
            style_class: 'quick-command-footer-group',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        footerRight.add_child(this._createFooterHint('Tab', this._('Switch'))[0]);
        footerRight.add_child(this._createFooterHint('↑↓', this._('Select'))[0]);
        footerRight.add_child(this._createFooterHint('Esc', this._('Close'))[0]);
        footer.add_child(footerRight);
        this._panel.add_child(footer);

        this._updateResponsiveLayout();
        this._updateModeUi();
        this._refresh();
    }

    _createFooterHint(key, label) {
        const box = new St.BoxLayout({
            style_class: 'quick-command-footer-hint',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const kbd = new St.Label({
            style_class: 'quick-command-kbd',
            text: key,
            y_align: Clutter.ActorAlign.CENTER,
        });
        kbd.clutter_text.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(kbd);
        const actionLabel = new St.Label({
            style_class: 'quick-command-footer-label',
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(actionLabel);
        return [box, actionLabel];
    }

    _syncBlur() {
        const enabled = this._settings.get_boolean('blur-enabled');
        if (enabled && !this._blurEffect) {
            this._blurEffect = new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                brightness: 0.8,
            });
            // GNOME 46 renamed the blur strength property.
            if ('radius' in this._blurEffect)
                this._blurEffect.radius = 24;
            else
                this._blurEffect.sigma = 12;
            this._blurBed.add_effect_with_name(
                'quick-command-blur',
                this._blurEffect
            );
        } else if (!enabled && this._blurEffect) {
            this._blurBed.remove_effect_by_name('quick-command-blur');
            this._blurEffect = null;
        }
    }

    _createTab(label, mode) {
        const button = new St.Button({
            style_class: 'quick-command-tab',
            label,
            can_focus: true,
        });
        button.connect('clicked', () => this._setMode(mode));
        return button;
    }

    toggle() {
        if (this.state === ModalDialog.State.CLOSED) {
            this.showLauncher();
        } else if (this.state === ModalDialog.State.CLOSING) {
            this._reopenAfterClose = !this._reopenAfterClose;
        } else {
            this._reopenAfterClose = false;
            this.close();
        }
    }

    showLauncher() {
        if (this._destroying || this.state !== ModalDialog.State.CLOSED)
            return;

        this._pasteTargetWindow = global.display.focus_window;
        this._pasteWithShift = isTerminalWindow(this._pasteTargetWindow);
        this._updateResponsiveLayout();
        this._setMode(MODE_APPS);
        this._entry.set_text('');
        this._selectedIndex = 0;
        this._refresh();
        this._opening = true;
        this.connect('opened', this._onOpened);
        this.open();
        this._entry.grab_key_focus();
    }

    _onOpened() {
        if (this._destroying)
            return;
        this._opening = false;
        this.disconnect(this._onOpened);
    }

    onClipboardChanged() {
        if (this.visible && this._mode === MODE_CLIPBOARD)
            this._refresh();
    }

    _setMode(mode) {
        if (this._mode === mode)
            return;

        this._mode = mode;
        this._selectedIndex = 0;
        this._entry.set_text('');
        this._updateModeUi();
        this._refresh();
        this._entry.grab_key_focus();
    }

    _updateModeUi() {
        this._appTab.set_style_pseudo_class(
            this._mode === MODE_APPS ? 'checked' : null
        );
        this._clipboardTab.set_style_pseudo_class(
            this._mode === MODE_CLIPBOARD ? 'checked' : null
        );
        this._clearButton.visible = this._mode === MODE_CLIPBOARD;
        this._deleteHint.visible = this._mode === MODE_CLIPBOARD;
        this._resultsScrollView.visible = this._mode === MODE_APPS;
        this._clipboardWorkspace.visible = this._mode === MODE_CLIPBOARD;
        this._entry.hint_text = this._mode === MODE_APPS
            ? this._('Search applications…')
            : this._('Search clipboard history…');
        this._actionHint.text = this._mode === MODE_APPS
            ? this._('Open')
            : this._('Paste');
    }

    _updateResponsiveLayout() {
        let monitorIndex = this._pasteTargetWindow?.get_monitor?.();
        if (!Number.isInteger(monitorIndex) || monitorIndex < 0)
            monitorIndex = global.display.get_current_monitor();
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const width = clamp(
            Math.round(workArea.width * 0.52),
            PANEL_MIN_WIDTH,
            PANEL_MAX_WIDTH
        );
        const height = clamp(
            Math.round(workArea.height * 0.62),
            PANEL_MIN_HEIGHT,
            PANEL_MAX_HEIGHT
        );
        const clipboardListWidth = Math.round(width * 0.4);
        const clipboardDetailsWidth = width - clipboardListWidth;

        this._panel.set_style(`width: ${width}px; height: ${height}px;`);
        // Only widths are pinned here. All heights flow from y_expand —
        // pinning any child height over-constrains the fixed-height panel
        // and the box layout then steals the difference from the search
        // entry, shrinking it in one mode but not the other.
        this._clipboardListScrollView.set_style(
            `width: ${clipboardListWidth}px;`
        );
        this._clipboardDetails.set_style(
            `width: ${clipboardDetailsWidth}px;`
        );
        this._clipboardPreviewWidth = clipboardDetailsWidth;
        // Upper bound for fitting image previews; the actual allocation is
        // the y_expand remainder, so approximate it from the panel height.
        this._clipboardPreviewHeight = Math.round(
            (height - PANEL_FIXED_CONTENT_HEIGHT) * 0.6
        );
    }

    _refresh() {
        const listBox = this._mode === MODE_APPS
            ? this._resultsBox
            : this._clipboardListBox;
        for (const child of listBox.get_children())
            child.destroy();
        this._visibleItems = [];
        const scrollView = this._mode === MODE_APPS
            ? this._resultsScrollView
            : this._clipboardListScrollView;
        scrollView.vadjustment.value = 0;

        const query = this._entry.get_text().trim();
        if (this._mode === MODE_APPS)
            this._renderApps(query);
        else
            this._renderClipboard(query);

        if (this._visibleItems.length === 0) {
            listBox.add_child(new St.Label({
                style_class: 'quick-command-empty',
                text: this._mode === MODE_APPS
                    ? this._('No applications found')
                    : this._('Clipboard history is empty'),
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            }));
            this._selectedIndex = -1;
            if (this._mode === MODE_CLIPBOARD)
                this._renderClipboardDetails(null);
        } else {
            this._selectedIndex = Math.min(
                Math.max(this._selectedIndex, 0),
                this._visibleItems.length - 1
            );
            this._updateSelection();
        }
    }

    _renderApps(query) {
        for (const app of this._appIndex.search(query, MAX_RESULT_ITEMS)) {
            const actor = this._createResultRow({
                icon: app.create_icon_texture(28),
                title: app.get_name(),
                description: this._('Application'),
                activate: () => {
                    this.close();
                    app.activate();
                },
            });
            this._resultsBox.add_child(actor);
        }
    }

    _renderClipboard(query) {
        const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase();
        const imageKeywords = `${this._('Image')} image`;
        const items = this._clipboardHistory.getItems()
            .filter(item =>
                clipboardMatches(item, normalizedQuery, imageKeywords))
            .slice(0, MAX_RESULT_ITEMS);

        let previousGroup = null;

        for (const item of items) {
            const createdAt = new Date(item.createdAt);
            const group = clipboardGroup(createdAt);
            if (group !== previousGroup) {
                this._clipboardListBox.add_child(new St.Label({
                    style_class: 'quick-command-clipboard-group-title',
                    text: this._clipboardGroupLabel(group),
                    x_align: Clutter.ActorAlign.START,
                }));
                previousGroup = group;
            }

            const actor = this._createClipboardRow(item);
            this._clipboardListBox.add_child(actor);
        }
    }

    _createClipboardRow(item) {
        const button = new St.Button({
            style_class: 'quick-command-clipboard-item',
            can_focus: true,
            x_expand: true,
        });
        const content = new St.BoxLayout({
            style_class: 'quick-command-clipboard-item-content',
            x_expand: true,
        });
        const icon = item.type === 'image'
            ? this._createImageThumbnail(item)
            : new St.Icon({
                style_class: 'quick-command-clipboard-text-icon',
                icon_name: 'edit-paste-symbolic',
                icon_size: 24,
            });
        icon.y_align = Clutter.ActorAlign.CENTER;
        content.add_child(icon);

        const labels = new St.BoxLayout({
            style_class: 'quick-command-clipboard-item-labels',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({
            style_class: 'quick-command-clipboard-item-title',
            text: item.type === 'image'
                ? imageTitle(item, this._('Image'))
                : compactText(item.text, 72),
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        title.clutter_text.single_line_mode = true;
        labels.add_child(title);
        content.add_child(labels);
        button.set_child(content);

        const activate = () => {
            if (!this._clipboardHistory.copyItem(item))
                return;
            this._pendingPaste = {
                content: item.type === 'image' ? null : item.text,
                targetWindow: this._pasteTargetWindow,
                useShift: this._pasteWithShift,
            };
            this.close();
        };
        const visibleItem = {actor: button, activate, clipboardItem: item};
        button.connect('clicked', activate);
        button.connect('enter-event', () => {
            // Only follow the pointer while the dialog is already open and
            // focus is on the search entry; the enter-event that fires on
            // open would otherwise yank the selection to wherever the
            // pointer happens to rest.
            if (!this.visible || this._opening ||
                global.stage.get_key_focus() !== this._entry.clutter_text)
                return Clutter.EVENT_PROPAGATE;
            this._selectedIndex = this._visibleItems.indexOf(visibleItem);
            this._updateSelection();
            return Clutter.EVENT_PROPAGATE;
        });
        this._visibleItems.push(visibleItem);
        return button;
    }

    _clipboardGroupLabel(group) {
        const labels = {
            Earlier: this._('Earlier'),
            Today: this._('Today'),
            Yesterday: this._('Yesterday'),
            'This Week': this._('This Week'),
            'This Month': this._('This Month'),
        };
        return labels[group] ?? labels.Earlier;
    }

    _createImageThumbnail(item) {
        const imagePath = this._clipboardHistory.getImagePath(item);
        if (!imagePath) {
            return new St.Icon({
                icon_name: 'image-x-generic-symbolic',
                icon_size: 28,
            });
        }

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage)
            .scale_factor;
        const [thumbnailWidth, thumbnailHeight] =
            fitImageDimensions(imagePath, 36, 36);
        const texture = St.TextureCache.get_default().load_file_async(
            Gio.File.new_for_path(imagePath),
            thumbnailWidth,
            thumbnailHeight,
            scaleFactor,
            1
        );
        texture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
        texture.set_size(thumbnailWidth, thumbnailHeight);
        texture.x_align = Clutter.ActorAlign.CENTER;
        texture.y_align = Clutter.ActorAlign.CENTER;

        return new St.Bin({
            style_class: 'quick-command-image-thumbnail',
            child: texture,
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _renderClipboardDetails(item) {
        for (const child of this._clipboardPreviewBox.get_children())
            child.destroy();
        for (const child of this._clipboardInfoBox.get_children())
            child.destroy();

        if (!item) {
            this._clipboardPreviewBox.add_child(new St.Label({
                style_class: 'quick-command-clipboard-preview-empty',
                text: this._('Select an item to view details'),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            }));
            return;
        }

        if (item.type === 'image') {
            this._clipboardPreviewBox.add_child(
                this._createImagePreview(item)
            );
        } else {
            const preview = new St.Label({
                style_class: 'quick-command-clipboard-text-preview',
                text: item.text,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
            });
            preview.clutter_text.line_wrap = true;
            preview.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            preview.clutter_text.selectable = true;
            this._clipboardPreviewBox.add_child(preview);
        }

        this._clipboardInfoBox.add_child(new St.Label({
            style_class: 'quick-command-clipboard-info-title',
            text: this._('Details'),
            x_align: Clutter.ActorAlign.START,
        }));
        this._addClipboardInfoRow(
            this._('Source'),
            item.source || this._('Unknown source')
        );
        this._addClipboardInfoRow(
            this._('Type'),
            item.type === 'image'
                ? item.mimeType
                : `${this._('Text')} · text/plain`
        );
        this._addClipboardInfoRow(
            this._('Size'),
            formatBytes(item.type === 'image' ? item.byteSize : textByteSize(item))
        );
    }

    _createImagePreview(item) {
        const imagePath = this._clipboardHistory.getImagePath(item);
        if (!imagePath) {
            return new St.Icon({
                style_class: 'quick-command-clipboard-preview-missing',
                icon_name: 'image-missing-symbolic',
                icon_size: 64,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            });
        }

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage)
            .scale_factor;
        const [previewWidth, previewHeight] = fitImageDimensions(
            imagePath,
            Math.max(1, this._clipboardPreviewWidth - 56),
            Math.max(1, this._clipboardPreviewHeight - 40)
        );
        const texture = St.TextureCache.get_default().load_file_async(
            Gio.File.new_for_path(imagePath),
            previewWidth,
            previewHeight,
            scaleFactor,
            1
        );
        texture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
        texture.set_size(previewWidth, previewHeight);
        texture.x_align = Clutter.ActorAlign.CENTER;
        texture.y_align = Clutter.ActorAlign.CENTER;

        return new St.Bin({
            style_class: 'quick-command-clipboard-image-preview',
            child: texture,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
    }

    _addClipboardInfoRow(label, value) {
        const row = new St.BoxLayout({
            style_class: 'quick-command-clipboard-info-row',
            x_expand: true,
        });
        row.add_child(new St.Label({
            style_class: 'quick-command-clipboard-info-label',
            text: label,
            x_align: Clutter.ActorAlign.START,
        }));
        const valueLabel = new St.Label({
            style_class: 'quick-command-clipboard-info-value',
            text: value,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        valueLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        valueLabel.clutter_text.single_line_mode = true;
        row.add_child(valueLabel);
        this._clipboardInfoBox.add_child(row);
    }

    _createResultRow({icon, title, description, activate}) {
        const button = new St.Button({
            style_class: 'quick-command-result',
            can_focus: true,
            x_expand: true,
        });
        const content = new St.BoxLayout({
            style_class: 'quick-command-result-content',
            x_expand: true,
        });
        icon.y_align = Clutter.ActorAlign.CENTER;
        content.add_child(icon);

        const titleLabel = new St.Label({
            style_class: 'quick-command-result-title',
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
        });
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleLabel.clutter_text.single_line_mode = true;
        content.add_child(titleLabel);

        if (description) {
            const metaLabel = new St.Label({
                style_class: 'quick-command-result-meta',
                text: description,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.END,
            });
            metaLabel.clutter_text.single_line_mode = true;
            content.add_child(metaLabel);
        }
        button.set_child(content);

        const item = {actor: button, activate};
        button.connect('clicked', () => activate());
        button.connect('enter-event', () => {
            // Same guard as the clipboard rows: ignore the enter-event
            // emitted on open, only track the pointer during interaction.
            if (!this.visible || this._opening ||
                global.stage.get_key_focus() !== this._entry.clutter_text)
                return Clutter.EVENT_PROPAGATE;
            this._selectedIndex = this._visibleItems.indexOf(item);
            this._updateSelection();
            return Clutter.EVENT_PROPAGATE;
        });
        this._visibleItems.push(item);
        return button;
    }

    _onKeyPressed(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Tab) {
            this._setMode(this._mode === MODE_APPS ? MODE_CLIPBOARD : MODE_APPS);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Down) {
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Up) {
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return ||
            key === Clutter.KEY_KP_Enter ||
            key === Clutter.KEY_ISO_Enter) {
            this._activateSelected();
            return Clutter.EVENT_STOP;
        }
        if (this._mode === MODE_CLIPBOARD &&
            (key === Clutter.KEY_Delete || key === Clutter.KEY_KP_Delete) &&
            (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            this._deleteSelected();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _moveSelection(delta) {
        if (this._visibleItems.length === 0)
            return;
        this._selectedIndex = (
            this._selectedIndex + delta + this._visibleItems.length
        ) % this._visibleItems.length;
        this._updateSelection();
    }

    _updateSelection() {
        this._visibleItems.forEach((item, index) => {
            if (index === this._selectedIndex)
                item.actor.add_style_pseudo_class('selected');
            else
                item.actor.remove_style_pseudo_class('selected');
        });
        if (this._mode === MODE_CLIPBOARD) {
            this._renderClipboardDetails(
                this._visibleItems[this._selectedIndex]?.clipboardItem ?? null
            );
        }
        this._scrollSelectionIntoView();
    }

    _scrollSelectionIntoView() {
        if (this._selectedIndex < 0)
            return;

        const scrollView = this._mode === MODE_APPS
            ? this._resultsScrollView
            : this._clipboardListScrollView;
        const adjustment = scrollView.vadjustment;
        const {value, pageSize, upper} = adjustment;
        if (pageSize <= 0 || upper <= pageSize)
            return;

        // Jumping to the first item scrolls all the way up so the group
        // header above it stays visible instead of covering the row.
        if (this._selectedIndex === 0) {
            adjustment.value = 0;
            return;
        }

        // Use allocation (content) coordinates rather than transformed stage
        // coordinates: the latter go stale between a scroll and the next
        // relayout, which made fast key repeats drift off target.
        const actor = this._visibleItems[this._selectedIndex].actor;
        const rowTop = actor.allocation.y1;
        const rowBottom = actor.allocation.y2;
        let nextValue = value;

        if (rowTop < value)
            nextValue = rowTop;
        else if (rowBottom > value + pageSize)
            nextValue = rowBottom - pageSize;

        adjustment.value = clamp(nextValue, 0, upper - pageSize);
    }

    _activateSelected() {
        this._visibleItems[this._selectedIndex]?.activate();
    }

    _deleteSelected() {
        const item = this._visibleItems[this._selectedIndex]?.clipboardItem;
        if (!item)
            return;
        // The changed notification triggers onClipboardChanged, which
        // refreshes the list and clamps the selection.
        this._clipboardHistory.deleteItem(item);
    }

    destroy() {
        this._destroying = true;
        this._reopenAfterClose = false;
        if (this._opening)
            this.disconnect(this._onOpened);
        this._opening = false;
        this._pendingPaste = null;
        this._pasteTargetWindow = null;
        if (this._blurChangedId) {
            this._settings.disconnect(this._blurChangedId);
            this._blurChangedId = 0;
        }
        this._settings = null;
        this.remove_all_transitions();
        this.popModal();
        this._pasteController.destroy();
        this._pasteController = null;
        this._visibleItems = [];
        this._appIndex = null;
        this._clipboardHistory = null;
        super.destroy();
    }
});
