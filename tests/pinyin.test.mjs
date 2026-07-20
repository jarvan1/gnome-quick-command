import assert from 'node:assert/strict';

import {pinyinAliases} from '../lib/pinyin.js';

const terminal = pinyinAliases('终端');
assert(terminal.includes('zhongduan'));
assert(terminal.includes('zd'));

const files = pinyinAliases('文件管理器');
assert(files.includes('wenjianguanliqi'));
assert(files.includes('wjglq'));

const chongqing = pinyinAliases('重庆');
assert(chongqing.includes('chongqing'));
assert(chongqing.includes('zhongqing'));

const mixed = pinyinAliases('WPS 文字');
assert(mixed.includes('wpswenzi'));
assert(mixed.includes('wpswz'));

console.log('Pinyin alias tests passed');
