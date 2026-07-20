import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PASTE_DELAY_MS = 200;
const TERMINAL_IDENTIFIERS = [
    'alacritty',
    'foot',
    'gnome-console',
    'gnome-terminal',
    'kgx',
    'kitty',
    'terminator',
    'terminal',
    'tilix',
    'wezterm',
    'xterm',
];

export function isTerminalWindow(window) {
    if (!window)
        return false;

    const identifiers = [
        window.get_wm_class?.(),
        window.get_wm_class_instance?.(),
        window.get_gtk_application_id?.(),
    ].filter(Boolean).join(' ').toLocaleLowerCase();

    return TERMINAL_IDENTIFIERS.some(name => identifiers.includes(name));
}

export class PasteController {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualKeyboard = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE
        );
        this._sourceId = 0;
    }

    paste(text, targetWindow, useTerminalShortcut = false) {
        if (this._sourceId)
            GLib.Source.remove(this._sourceId);

        if (targetWindow) {
            try {
                Main.activateWindow(targetWindow);
            } catch (error) {
                console.error(`Quick Command could not restore target window: ${error}`);
            }
        }

        this._sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PASTE_DELAY_MS,
            () => {
                this._sourceId = 0;
                this._deliverText(text, targetWindow, useTerminalShortcut);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _deliverText(text, targetWindow, useTerminalShortcut) {
        if (targetWindow && global.display.focus_window !== targetWindow) {
            console.error('Quick Command did not paste because the target window lost focus');
            return;
        }

        if (Main.inputMethod.currentFocus) {
            try {
                Main.inputMethod.commit(text);
                return;
            } catch (error) {
                console.error(`Quick Command input method paste failed: ${error}`);
            }
        }

        this._sendPasteShortcut(useTerminalShortcut);
    }

    _sendPasteShortcut(useTerminalShortcut) {
        if (!this._virtualKeyboard)
            return;

        let timestamp = GLib.get_monotonic_time();
        const notify = (key, state) => {
            this._virtualKeyboard.notify_keyval(timestamp, key, state);
            timestamp += 1000;
        };

        try {
            notify(Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            if (useTerminalShortcut)
                notify(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            notify(Clutter.KEY_v, Clutter.KeyState.PRESSED);
            notify(Clutter.KEY_v, Clutter.KeyState.RELEASED);
            if (useTerminalShortcut)
                notify(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            notify(Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        } catch (error) {
            console.error(`Quick Command could not paste text: ${error}`);
            this._releaseModifiers(timestamp);
        }
    }

    _releaseModifiers(timestamp) {
        try {
            this._virtualKeyboard.notify_keyval(
                timestamp,
                Clutter.KEY_Shift_L,
                Clutter.KeyState.RELEASED
            );
            this._virtualKeyboard.notify_keyval(
                timestamp + 1000,
                Clutter.KEY_Control_L,
                Clutter.KeyState.RELEASED
            );
        } catch (error) {
            console.error(`Quick Command could not release paste modifiers: ${error}`);
        }
    }

    destroy() {
        if (this._sourceId) {
            GLib.Source.remove(this._sourceId);
            this._sourceId = 0;
        }
        this._virtualKeyboard?.run_dispose();
        this._virtualKeyboard = null;
    }
}
