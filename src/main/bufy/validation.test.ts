// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {
    acceleratorIdentity,
    captureSchema,
    checkAccelerator,
    isFailure,
    pushToTalkSchema,
    shareBorderSchema,
    shortcutIdSchema,
    shortcutSchema,
    validateArg,
    voiceStatusSchema,
} from './validation';

describe('bufy/validation', () => {
    describe('shareBorderSchema', () => {
        it.each([
            [{sourceId: 'screen:123:0'}],
            [{sourceId: 'window:2097177:1', color: '#00ff00', thickness: 4}],
            [{sourceId: 'screen:1:0', color: 'rgba(255, 0, 0, 0.5)'}],
        ])('accepts %j', (v) => {
            expect(isFailure(validateArg(shareBorderSchema, v))).toBe(false);
        });

        it.each([
            [undefined],
            [{}],
            [{sourceId: 'screen:abc:0'}],
            [{sourceId: '../../etc/passwd'}],
            [{sourceId: 'screen:1:0', color: 'red'}],
            [{sourceId: 'screen:1:0', color: '#fff;} body{display:none'}],
            [{sourceId: 'screen:1:0', color: 'url(http://evil)'}],
            [{sourceId: 'screen:1:0', thickness: 0}],
            [{sourceId: 'screen:1:0', thickness: 13}],
            [{sourceId: 'screen:1:0', thickness: 2.5}],
            ['screen:1:0'],
        ])('rejects %j', (v) => {
            const r = validateArg(shareBorderSchema, v);
            expect(isFailure(r) && r.error).toBe('invalid-argument');
        });
    });

    it('validates push-to-talk options', () => {
        expect(isFailure(validateArg(pushToTalkSchema, {key: 'Space', modifiers: ['ctrl']}))).toBe(false);
        expect(isFailure(validateArg(pushToTalkSchema, {key: 'Space', modifiers: ['ctrl', 'ctrl']}))).toBe(true);
        expect(isFailure(validateArg(pushToTalkSchema, {key: 'Space', modifiers: ['hyper']}))).toBe(true);
        expect(isFailure(validateArg(pushToTalkSchema, {key: 'x'.repeat(100)}))).toBe(true);
        expect(isFailure(validateArg(pushToTalkSchema, {}))).toBe(true);
    });

    it('validates capture options and shortcut ids', () => {
        expect(isFailure(validateArg(captureSchema, {}))).toBe(false);
        expect(isFailure(validateArg(captureSchema, {timeoutMs: 5000}))).toBe(false);
        expect(isFailure(validateArg(captureSchema, {timeoutMs: 10}))).toBe(true);
        expect(isFailure(validateArg(captureSchema, {timeoutMs: 999999}))).toBe(true);
        expect(isFailure(validateArg(shortcutIdSchema, 'toggle-mute'))).toBe(false);
        expect(isFailure(validateArg(shortcutIdSchema, 'bad id'))).toBe(true);
        expect(isFailure(validateArg(shortcutIdSchema, ''))).toBe(true);
        expect(isFailure(validateArg(shortcutSchema, {id: 'a', accelerator: 'F9'}))).toBe(false);
    });

    it('validates and strips voice status', () => {
        const ok = validateArg<{connected: boolean; extra?: unknown}>(voiceStatusSchema, {connected: true, muted: false, roomName: 'Lobby', extra: 'x', labels: {mute: 'Sustur'}});
        expect(isFailure(ok)).toBe(false);
        expect((ok as {value: {extra?: unknown}}).value.extra).toBeUndefined();
        expect(isFailure(validateArg(voiceStatusSchema, {muted: true}))).toBe(true);
        expect(isFailure(validateArg(voiceStatusSchema, {connected: true, roomName: 'x'.repeat(200)}))).toBe(true);
        expect(isFailure(validateArg(voiceStatusSchema, {connected: true, labels: {mute: 'x'.repeat(100)}}))).toBe(true);
    });

    describe('checkAccelerator', () => {
        it.each([
            'CommandOrControl+Shift+M',
            'Ctrl+Alt+D',
            'F9',
            'Shift+F13',
            'MediaPlayPause',
            'Alt+Space',
            'CommandOrControl+Plus',
        ])('accepts %s', (a) => {
            expect(checkAccelerator(a)).toMatchObject({ok: true});
        });

        it.each([
            ['A', 'alone'],
            ['Shift+A', 'shift only'],
            ['Space', 'alone'],
            ['Ctrl+C', 'reserved'],
            ['CommandOrControl+V', 'reserved'],
            ['Cmd+Q', 'reserved'],
            ['Alt+F4', 'reserved'],
            ['Alt+Tab', 'reserved'],
            ['Ctrl+Alt+Delete', 'reserved'],
            ['Ctrl+Shift+Esc', 'reserved'],
            ['Ctrl+', 'malformed'],
            ['Ctrl++', 'plus'],
            ['Hyper+K', 'unknown modifier'],
            ['Ctrl+Ctrl+K', 'duplicate'],
            ['Ctrl+Foo', 'unknown key'],
            ['Ctrl+F25', 'unknown key'],
        ])('rejects %s (%s)', (a) => {
            expect(checkAccelerator(a)).toMatchObject({ok: false});
        });

        it('treats equivalent accelerators as the same identity', () => {
            expect(acceleratorIdentity('CommandOrControl+Shift+M')).toBe(acceleratorIdentity('ctrl+shift+m'));
            expect(acceleratorIdentity('Shift+Ctrl+M')).toBe(acceleratorIdentity('Ctrl+Shift+M'));
            expect(acceleratorIdentity('Ctrl+M')).not.toBe(acceleratorIdentity('Alt+M'));
        });
    });
});
