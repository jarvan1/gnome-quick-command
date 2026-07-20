import Shell from 'gi://Shell';

import {pinyinAliases} from './pinyin.js';

function normalize(value) {
    return (value ?? '').normalize('NFKC').toLocaleLowerCase();
}

function scoreField(field, query) {
    if (!query)
        return 1;

    const text = normalize(field);
    if (!text)
        return -1;
    if (text === query)
        return 1000;
    if (text.startsWith(query))
        return 850 - Math.min(text.length - query.length, 100);

    const containedAt = text.indexOf(query);
    if (containedAt >= 0)
        return 650 - Math.min(containedAt * 4, 200);

    let queryIndex = 0;
    let firstMatch = -1;
    let previousMatch = -1;
    let gaps = 0;

    for (let index = 0; index < text.length && queryIndex < query.length; index++) {
        if (text[index] !== query[queryIndex])
            continue;

        if (firstMatch < 0)
            firstMatch = index;
        if (previousMatch >= 0)
            gaps += index - previousMatch - 1;
        previousMatch = index;
        queryIndex++;
    }

    if (queryIndex !== query.length)
        return -1;

    return 400 - Math.min(firstMatch * 3 + gaps * 5, 300);
}

function buildSearchFields(app) {
    const appInfo = app.get_app_info();
    const keywords = appInfo?.get_keywords?.() ?? [];
    const localizedNames = [app.get_name(), ...keywords];

    return [
        ...localizedNames,
        app.get_id(),
        app.get_description(),
        ...localizedNames.flatMap(field => pinyinAliases(field)),
    ];
}

function scoreApp(appRecord, query) {
    if (!query)
        return 1;

    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    let total = 0;
    for (const token of tokens) {
        const tokenScore = Math.max(
            ...appRecord.searchFields.map(field => scoreField(field, token))
        );
        if (tokenScore < 0)
            return -1;
        total += tokenScore;
    }

    return total;
}

export class AppIndex {
    constructor() {
        this._appSystem = Shell.AppSystem.get_default();
        this._installedChangedId = this._appSystem.connect(
            'installed-changed',
            () => this._refresh()
        );
        this._refresh();
    }

    _refresh() {
        this._apps = this._appSystem.get_installed()
            .filter(appInfo => appInfo.should_show())
            .map(appInfo => this._appSystem.lookup_app(appInfo.get_id()))
            .filter(app => app !== null)
            .map(app => ({app, searchFields: buildSearchFields(app)}))
            .sort((left, right) =>
                left.app.get_name().localeCompare(right.app.get_name())
            );
    }

    search(query, limit = 8) {
        return this._apps
            .map(record => ({
                app: record.app,
                score: scoreApp(record, query),
            }))
            .filter(result => result.score >= 0)
            .sort((left, right) =>
                right.score - left.score ||
                left.app.get_name().localeCompare(right.app.get_name())
            )
            .slice(0, limit)
            .map(result => result.app);
    }

    destroy() {
        if (this._installedChangedId) {
            this._appSystem.disconnect(this._installedChangedId);
            this._installedChangedId = 0;
        }
        this._apps = [];
        this._appSystem = null;
    }
}
