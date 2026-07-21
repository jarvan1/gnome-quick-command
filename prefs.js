import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class QuickCommandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const _ = this.gettext.bind(this);
        window.set_default_size(560, 520);

        const page = new Adw.PreferencesPage({
            title: 'Quick Command',
            icon_name: 'system-search-symbolic',
        });
        window.add(page);

        const launcherGroup = new Adw.PreferencesGroup({
            title: _('Launcher'),
            description: _('Use GTK accelerator syntax, such as <Super>r or <Ctrl>space.'),
        });
        page.add(launcherGroup);

        const shortcutRow = new Adw.EntryRow({
            title: _('Open shortcut'),
            text: settings.get_strv('open-launcher')[0] ?? '<Ctrl><Alt>space',
        });
        shortcutRow.connect('changed', () => {
            const [parsed, key, modifiers] = Gtk.accelerator_parse(shortcutRow.text);
            const valid = parsed && Gtk.accelerator_valid(key, modifiers);
            if (valid) {
                shortcutRow.remove_css_class('error');
                settings.set_strv('open-launcher', [
                    Gtk.accelerator_name(key, modifiers),
                ]);
            } else {
                shortcutRow.add_css_class('error');
            }
        });
        launcherGroup.add(shortcutRow);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
        });
        page.add(appearanceGroup);

        const blurSwitch = new Adw.SwitchRow({
            title: _('Background blur'),
            subtitle: _('Gaussian blur behind the panel. Turn off if opening feels slow.'),
        });
        settings.bind(
            'blur-enabled',
            blurSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        appearanceGroup.add(blurSwitch);

        const clipboardGroup = new Adw.PreferencesGroup({
            title: _('Clipboard'),
            description: _('Text and images are stored in the current user data directory for 7 days.'),
        });
        page.add(clipboardGroup);

        const clipboardSwitch = new Adw.SwitchRow({
            title: _('Record clipboard history'),
            subtitle: _('Turning this off stops capturing new content but keeps existing history.'),
        });
        settings.bind(
            'clipboard-enabled',
            clipboardSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        clipboardGroup.add(clipboardSwitch);

        const clipboardImagesSwitch = new Adw.SwitchRow({
            title: _('Record images'),
            subtitle: _('Supports PNG, JPEG, WebP, and BMP up to 20 MB per image.'),
        });
        settings.bind(
            'clipboard-images-enabled',
            clipboardImagesSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            'clipboard-enabled',
            clipboardImagesSwitch,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );
        clipboardGroup.add(clipboardImagesSwitch);

        const historySize = new Adw.SpinRow({
            title: _('History size'),
            subtitle: _('Items older than 7 days or beyond this limit are deleted automatically.'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 500,
                step_increment: 10,
                page_increment: 50,
            }),
            value: settings.get_int('clipboard-history-size'),
        });
        historySize.connect('notify::value', () => {
            settings.set_int('clipboard-history-size', Math.round(historySize.value));
        });
        clipboardGroup.add(historySize);

        const privacyGroup = new Adw.PreferencesGroup({
            title: _('Privacy'),
        });
        page.add(privacyGroup);
        privacyGroup.add(new Adw.ActionRow({
            title: _('This version records text and images'),
            subtitle: _('Image storage is limited to 200 MB. Do not copy passwords, tokens, or sensitive images.'),
            icon_name: 'channel-secure-symbolic',
        }));
    }
}
