import {PINYIN_DATA} from './pinyinData.js';

const MAX_VARIANTS = 24;
const readingCache = new Map();

function getReadings(character) {
    if (readingCache.has(character))
        return readingCache.get(character);

    const marker = `\n${character}:`;
    const valueStart = PINYIN_DATA.indexOf(marker);
    if (valueStart < 0) {
        readingCache.set(character, null);
        return null;
    }

    const readingStart = valueStart + marker.length;
    const readingEnd = PINYIN_DATA.indexOf('\n', readingStart);
    const readings = PINYIN_DATA.slice(readingStart, readingEnd)
        .split(',')
        .slice(0, 3);
    readingCache.set(character, readings);
    return readings;
}

function appendLiteral(states, character) {
    if (!/[a-z0-9]/i.test(character))
        return states;

    return states.map(state => ({
        full: state.full + character.toLocaleLowerCase(),
        initials: state.initials + character.toLocaleLowerCase(),
    }));
}

export function pinyinAliases(value) {
    if (!value || !/\p{Script=Han}/u.test(value))
        return [];

    let states = [{full: '', initials: ''}];

    for (const character of value.normalize('NFKC')) {
        const readings = getReadings(character);
        if (!readings) {
            states = appendLiteral(states, character);
            continue;
        }

        const nextStates = [];
        for (const state of states) {
            for (const reading of readings) {
                nextStates.push({
                    full: state.full + reading,
                    initials: state.initials + reading[0],
                });
                if (nextStates.length >= MAX_VARIANTS)
                    break;
            }
            if (nextStates.length >= MAX_VARIANTS)
                break;
        }
        states = nextStates;
    }

    const aliases = new Set();
    for (const state of states) {
        if (state.full)
            aliases.add(state.full);
        if (state.initials)
            aliases.add(state.initials);
    }
    return [...aliases];
}
