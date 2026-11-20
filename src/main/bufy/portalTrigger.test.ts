// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {triggerForAccelerator, triggerForKey} from './portalTrigger';

describe('bufy/portalTrigger', () => {
    describe('triggerForKey', () => {
        it.each([
            ['KeyV', [], 'v'],
            ['Space', [], 'space'],
            ['F13', [], 'F13'],
            ['Digit5', [], '5'],
            ['Numpad3', [], 'KP_3'],
            ['Backquote', ['ctrl'], 'CTRL+grave'],
            ['KeyM', ['shift', 'ctrl', 'meta'], 'CTRL+SHIFT+LOGO+m'],
            ['PageDown', ['alt'], 'ALT+Page_Down'],
            ['ControlRight', ['shift'], 'Control_R'],
            ['PrintScreen', [], 'Print'],
        ] as const)('%s + %j -> %s', (key, mods, expected) => {
            expect(triggerForKey(key, [...mods])).toBe(expected);
        });

        it('has no trigger for mouse buttons and unknown keys', () => {
            expect(triggerForKey('Mouse4')).toBeUndefined();
            expect(triggerForKey('MouseBack')).toBeUndefined();
            expect(triggerForKey('Nope')).toBeUndefined();
        });
    });

    describe('triggerForAccelerator', () => {
        it.each([
            ['CommandOrControl+Shift+M', 'CTRL+SHIFT+m'],
            ['Ctrl+Alt+5', 'CTRL+ALT+5'],
            ['Super+Space', 'LOGO+space'],
            ['F9', 'F9'],
            ['Alt+PageUp', 'ALT+Page_Up'],
            ['MediaPlayPause', 'XF86AudioPlay'],
            ['Ctrl+Plus', 'CTRL+plus'],
            ['Ctrl+`', 'CTRL+grave'],
            ['Ctrl+num7', 'CTRL+KP_7'],
        ])('%s -> %s', (accel, expected) => {
            expect(triggerForAccelerator(accel)).toBe(expected);
        });

        it('returns undefined for unknown parts', () => {
            expect(triggerForAccelerator('Hyper+K')).toBeUndefined();
            expect(triggerForAccelerator('Ctrl+Bogus')).toBeUndefined();
        });
    });
});
