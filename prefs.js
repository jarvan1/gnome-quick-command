import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class QuickCommandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 520);

        const page = new Adw.PreferencesPage({
            title: 'Quick Command',
            icon_name: 'system-search-symbolic',
        });
        window.add(page);

        const launcherGroup = new Adw.PreferencesGroup({
            title: '启动器',
            description: '使用 GTK accelerator 格式，例如 <Super>r 或 <Ctrl>space。',
        });
        page.add(launcherGroup);

        const shortcutRow = new Adw.EntryRow({
            title: '呼出快捷键',
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

        const clipboardGroup = new Adw.PreferencesGroup({
            title: '剪贴板',
            description: '文本与图片保存在当前用户的数据目录中，并保留 7 天。',
        });
        page.add(clipboardGroup);

        const clipboardSwitch = new Adw.SwitchRow({
            title: '记录剪贴板历史',
            subtitle: '关闭后停止捕获新内容，已有记录会保留',
        });
        settings.bind(
            'clipboard-enabled',
            clipboardSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        clipboardGroup.add(clipboardSwitch);

        const clipboardImagesSwitch = new Adw.SwitchRow({
            title: '记录图片',
            subtitle: '支持 PNG、JPEG、WebP 和 BMP，单张最大 20 MB',
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
            title: '历史记录数量',
            subtitle: '超过 7 天或超出数量限制的旧记录会自动删除',
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

        const privacyGroup = new Adw.PreferencesGroup({title: '隐私说明'});
        page.add(privacyGroup);
        privacyGroup.add(new Adw.ActionRow({
            title: '当前版本记录文本与图片',
            subtitle: '图片总存储上限为 200 MB；请勿复制密码、令牌或敏感图片。',
            icon_name: 'channel-secure-symbolic',
        }));
    }
}
