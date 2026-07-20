import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppIndex} from './lib/appIndex.js';
import {ClipboardHistory} from './lib/clipboardHistory.js';
import {QuickCommandDialog} from './lib/launcherDialog.js';

const KEYBINDING = 'open-launcher';

export default class QuickCommandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._appIndex = new AppIndex();
        this._clipboardHistory = new ClipboardHistory(this._settings);
        this._dialog = new QuickCommandDialog(
            this._appIndex,
            this._clipboardHistory
        );

        this._clipboardHistory.setChangedCallback(() => {
            this._dialog?.onClipboardChanged();
        });

        Main.wm.addKeybinding(
            KEYBINDING,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._dialog?.toggle()
        );
    }

    disable() {
        Main.wm.removeKeybinding(KEYBINDING);

        this._clipboardHistory?.setChangedCallback(null);
        this._dialog?.destroy();
        this._clipboardHistory?.destroy();
        this._appIndex?.destroy();

        this._dialog = null;
        this._clipboardHistory = null;
        this._appIndex = null;
        this._settings = null;
    }
}
