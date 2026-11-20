// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {
    KEYBOARD_CODES,
    keyNameFromKeycode,
    modifierOfKey,
    modifiersFromEvent,
    mouseNameFromButton,
    normalizeModifiers,
    parseKeyName,
} from './keys';

describe('bufy/keys', () => {
    it('parses keyboard codes and mouse buttons', () => {
        expect(parseKeyName('Space')).toEqual({type: 'keyboard', name: 'Space', keycode: 57});
        expect(parseKeyName('KeyV')).toEqual({type: 'keyboard', name: 'KeyV', keycode: 47});
        expect(parseKeyName('Mouse4')).toEqual({type: 'mouse', name: 'Mouse4', button: 4});
        expect(parseKeyName('Mouse5')).toEqual({type: 'mouse', name: 'Mouse5', button: 5});
        expect(parseKeyName('Mouse3')).toEqual({type: 'mouse', name: 'Mouse3', button: 3});
    });

    it('accepts mouse aliases and normalizes them', () => {
        expect(parseKeyName('MouseMiddle')).toMatchObject({name: 'Mouse3'});
        expect(parseKeyName('MouseBack')).toMatchObject({name: 'Mouse4'});
        expect(parseKeyName('MouseForward')).toMatchObject({name: 'Mouse5'});
    });

    it('never allows left/right mouse buttons or unknown names', () => {
        expect(parseKeyName('Mouse1')).toBeUndefined();
        expect(parseKeyName('Mouse2')).toBeUndefined();
        expect(parseKeyName('nope')).toBeUndefined();
        expect(parseKeyName('__proto__')).toBeUndefined();
        expect(parseKeyName('constructor')).toBeUndefined();
        expect(parseKeyName('')).toBeUndefined();
    });

    it('maps keycodes back to names and mouse buttons back to names', () => {
        expect(keyNameFromKeycode(57)).toBe('Space');
        expect(keyNameFromKeycode(999999)).toBeUndefined();
        expect(mouseNameFromButton(4)).toBe('Mouse4');
        expect(mouseNameFromButton(1)).toBeUndefined();
        expect(mouseNameFromButton('4')).toBeUndefined();
    });

    it('has unique keycodes for every non-aliased key', () => {
        const seen = new Map<number, string>();
        for (const [name, code] of Object.entries(KEYBOARD_CODES)) {
            expect(seen.get(code)).toBeUndefined();
            seen.set(code, name);
        }
    });

    it('detects modifier keys and builds modifier lists', () => {
        expect(modifierOfKey('ControlRight')).toBe('ctrl');
        expect(modifierOfKey('MetaLeft')).toBe('meta');
        expect(modifierOfKey('Space')).toBeUndefined();
        expect(modifiersFromEvent({ctrlKey: true, altKey: false, shiftKey: true, metaKey: false})).toEqual(['ctrl', 'shift']);
        expect(normalizeModifiers(['shift', 'ctrl', 'shift'])).toEqual(['ctrl', 'shift']);
        expect(normalizeModifiers(undefined)).toEqual([]);
    });
});
