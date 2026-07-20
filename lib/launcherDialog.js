import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isTerminalWindow, PasteController} from './pasteController.js';

const MAX_RESULT_ITEMS = 100;
const PANEL_MIN_WIDTH = 600;
const PANEL_MAX_WIDTH = 840;
const PANEL_MIN_HEIGHT = 500;
const PANEL_MAX_HEIGHT = 680;
const PANEL_FIXED_CONTENT_HEIGHT = 204;
const RESULT_ROW_HEIGHT = 48;
const RESULT_ROW_SPACING = 5;
const MODE_APPS = 'apps';
const MODE_CLIPBOARD = 'clipboard';

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function compactText(text, maxLength = 110) {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxLength)
        return singleLine;
    return `${singleLine.slice(0, maxLength - 1)}…`;
}

function clipboardMatches(item, query) {
    if (!query)
        return true;
    return item.text.normalize('NFKC').toLocaleLowerCase()
        .includes(query.normalize('NFKC').toLocaleLowerCase());
}

export const QuickCommandDialog = GObject.registerClass(
class QuickCommandDialog extends ModalDialog.ModalDialog {
    _init(appIndex, clipboardHistory) {
        super._init({
            styleClass: 'quick-command-modal',
            destroyOnClose: false,
        });

        this._appIndex = appIndex;
        this._clipboardHistory = clipboardHistory;
        this._mode = MODE_APPS;
        this._selectedIndex = 0;
        this._visibleItems = [];
        this._reopenAfterClose = false;
        this._destroying = false;
        this._pendingPaste = null;
        this._pasteWithShift = false;
        this._pasteTargetWindow = null;
        this._pasteController = new PasteController();

        this._buildUi();
        this.setInitialKeyFocus(this._entry);
        this.connect('closed', () => {
            if (!this._destroying && this._pendingPaste !== null) {
                const pendingPaste = this._pendingPaste;
                this._pendingPaste = null;
                this._pasteController.paste(
                    pendingPaste.text,
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
        this._panel = new St.BoxLayout({
            style_class: 'quick-command-panel',
            vertical: true,
            x_expand: true,
        });
        this.contentLayout.add_child(this._panel);

        const titleRow = new St.BoxLayout({
            style_class: 'quick-command-title-row',
            x_expand: true,
        });
        titleRow.add_child(new St.Label({
            style_class: 'quick-command-title',
            text: 'QUICK COMMAND',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        titleRow.add_child(new St.Label({
            style_class: 'quick-command-shortcut-hint',
            text: 'Tab 切换',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._panel.add_child(titleRow);

        this._entry = new St.Entry({
            style_class: 'quick-command-search-entry',
            hint_text: '搜索应用…',
            primary_icon: new St.Icon({
                style_class: 'quick-command-search-icon',
                icon_name: 'system-search-symbolic',
                icon_size: 20,
            }),
            can_focus: true,
            x_expand: true,
        });
        this._panel.add_child(this._entry);

        this._entry.clutter_text.connect('text-changed', () => this._refresh());
        this._entry.clutter_text.connect(
            'key-press-event',
            (_actor, event) => this._onKeyPressed(event)
        );

        const tabs = new St.BoxLayout({
            style_class: 'quick-command-tabs',
            x_expand: true,
        });
        this._appTab = this._createTab('应用', MODE_APPS);
        this._clipboardTab = this._createTab('剪贴板', MODE_CLIPBOARD);
        tabs.add_child(this._appTab);
        tabs.add_child(this._clipboardTab);

        this._clearButton = new St.Button({
            style_class: 'quick-command-clear-button',
            label: '清空历史',
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
        });
        this._resultsBox = new St.BoxLayout({
            style_class: 'quick-command-results',
            vertical: true,
            x_expand: true,
        });
        this._resultsScrollView.set_child(this._resultsBox);
        this._panel.add_child(this._resultsScrollView);

        const footer = new St.BoxLayout({
            style_class: 'quick-command-footer',
            x_expand: true,
        });
        footer.add_child(new St.Label({text: '↑↓ 选择'}));
        this._actionHint = new St.Label({text: 'Enter 打开'});
        footer.add_child(this._actionHint);
        footer.add_child(new St.Label({text: 'Esc 关闭'}));
        this._panel.add_child(footer);

        this._updateResponsiveLayout();
        this._updateModeUi();
        this._refresh();
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
        this.open();
        this._entry.grab_key_focus();
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
        this._entry.hint_text = this._mode === MODE_APPS
            ? '搜索应用…'
            : '搜索剪贴板历史…';
        this._actionHint.text = this._mode === MODE_APPS
            ? 'Enter 打开'
            : 'Enter 粘贴';
    }

    _updateResponsiveLayout() {
        let monitorIndex = this._pasteTargetWindow?.get_monitor?.();
        if (!Number.isInteger(monitorIndex) || monitorIndex < 0)
            monitorIndex = global.display.get_current_monitor();
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const width = clamp(
            Math.round(workArea.width * 0.36),
            PANEL_MIN_WIDTH,
            PANEL_MAX_WIDTH
        );
        const height = clamp(
            Math.round(workArea.height * 0.53),
            PANEL_MIN_HEIGHT,
            PANEL_MAX_HEIGHT
        );
        const resultsHeight = height - PANEL_FIXED_CONTENT_HEIGHT;

        this._panel.set_style(`width: ${width}px; height: ${height}px;`);
        this._resultsScrollView.set_style(`height: ${resultsHeight}px;`);
        this._resultsBox.set_style(`min-height: ${resultsHeight}px;`);
    }

    _refresh() {
        for (const child of this._resultsBox.get_children())
            child.destroy();
        this._visibleItems = [];
        this._resultsScrollView.vadjustment.value = 0;

        const query = this._entry.get_text().trim();
        if (this._mode === MODE_APPS)
            this._renderApps(query);
        else
            this._renderClipboard(query);

        if (this._visibleItems.length === 0) {
            this._resultsBox.add_child(new St.Label({
                style_class: 'quick-command-empty',
                text: this._mode === MODE_APPS
                    ? '没有找到应用'
                    : '剪贴板历史为空',
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            }));
            this._selectedIndex = -1;
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
                activate: () => {
                    this.close();
                    app.activate();
                },
            });
            this._resultsBox.add_child(actor);
        }
    }

    _renderClipboard(query) {
        const items = this._clipboardHistory.getItems()
            .filter(item => clipboardMatches(item, query))
            .slice(0, MAX_RESULT_ITEMS);

        for (const item of items) {
            const createdAt = new Date(item.createdAt);
            const time = Number.isNaN(createdAt.getTime())
                ? '历史记录'
                : createdAt.toLocaleString();
            const actor = this._createResultRow({
                icon: new St.Icon({
                    icon_name: 'edit-paste-symbolic',
                    icon_size: 28,
                }),
                title: compactText(item.text),
                description: time,
                activate: () => {
                    this._clipboardHistory.copy(item.text);
                    this._pendingPaste = {
                        text: item.text,
                        targetWindow: this._pasteTargetWindow,
                        useShift: this._pasteWithShift,
                    };
                    this.close();
                },
            });
            this._resultsBox.add_child(actor);
        }
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
        this._scrollSelectionIntoView();
    }

    _scrollSelectionIntoView() {
        if (this._selectedIndex < 0)
            return;

        const adjustment = this._resultsScrollView.vadjustment;
        const {value, pageSize, upper} = adjustment;
        if (pageSize <= 0 || upper <= pageSize)
            return;

        const rowTop = this._selectedIndex *
            (RESULT_ROW_HEIGHT + RESULT_ROW_SPACING);
        const rowBottom = rowTop + RESULT_ROW_HEIGHT;
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

    destroy() {
        this._destroying = true;
        this._reopenAfterClose = false;
        this._pendingPaste = null;
        this._pasteTargetWindow = null;
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
