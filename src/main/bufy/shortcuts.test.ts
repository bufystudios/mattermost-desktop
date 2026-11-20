// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {ShortcutRegistry} from './shortcuts';
import type {ShortcutBackend} from './shortcuts';

type VoidFn = () => void;

function make(opts: {registerResult?: boolean; preRegistered?: string[]} = {}) {
    const registered = new Map<string, VoidFn>();
    (opts.preRegistered ?? []).forEach((a) => registered.set(a.toLowerCase(), () => {}));
    const backend: ShortcutBackend = {
        register: jest.fn((accel: string, cb: () => void) => {
            if (opts.registerResult === false) {
                return false;
            }
            registered.set(accel.toLowerCase(), cb);
            return true;
        }),
        unregister: jest.fn((accel: string) => {
            registered.delete(accel.toLowerCase());
        }),
        isRegistered: jest.fn((accel: string) => registered.has(accel.toLowerCase())),
    };
    const emit = jest.fn();
    return {reg: new ShortcutRegistry(backend, emit), backend, registered, emit};
}

describe('bufy/ShortcutRegistry', () => {
    it('registers and routes the callback to the owning view with the plugin id', () => {
        const {reg, registered, emit} = make();
        expect(reg.register(7, 'mute', 'CommandOrControl+Shift+M')).toEqual({ok: true});
        registered.get('commandorcontrol+shift+m')?.();
        expect(emit).toHaveBeenCalledWith(7, 'mute');
    });

    it('rejects invalid / dangerous accelerators without touching the OS', () => {
        const {reg, backend} = make();
        expect(reg.register(1, 'x', 'A')).toMatchObject({ok: false, error: 'invalid-argument'});
        expect(reg.register(1, 'x', 'Ctrl+C')).toMatchObject({ok: false, error: 'invalid-argument'});
        expect(backend.register).not.toHaveBeenCalled();
    });

    it('does not let two views take the same accelerator (even spelled differently)', () => {
        const {reg} = make();
        reg.register(1, 'mute', 'CommandOrControl+Shift+M');
        expect(reg.register(2, 'mute', 'ctrl+shift+m')).toMatchObject({ok: false, error: 'in-use'});
    });

    it('does not steal an accelerator that is already registered elsewhere', () => {
        const {reg} = make({preRegistered: ['Ctrl+Alt+K']});
        expect(reg.register(1, 'k', 'Ctrl+Alt+K')).toMatchObject({ok: false, error: 'in-use'});
    });

    it('reports OS refusal', () => {
        const {reg} = make({registerResult: false});
        expect(reg.register(1, 'k', 'Ctrl+Alt+K')).toMatchObject({ok: false, error: 'registration-failed'});
        expect(reg.count(1)).toBe(0);
    });

    it('re-registering an id moves it to the new accelerator', () => {
        const {reg, registered} = make();
        reg.register(1, 'mute', 'Ctrl+Alt+M');
        reg.register(1, 'mute', 'Ctrl+Alt+N');
        expect(registered.has('ctrl+alt+m')).toBe(false);
        expect(registered.has('ctrl+alt+n')).toBe(true);
        expect(reg.count(1)).toBe(1);
    });

    it('re-registering the same id and accelerator is fine', () => {
        const {reg} = make();
        reg.register(1, 'mute', 'Ctrl+Alt+M');
        expect(reg.register(1, 'mute', 'Ctrl+Alt+M')).toEqual({ok: true});
    });

    it('caps shortcuts per view', () => {
        const {reg} = make();
        for (let i = 1; i <= 16; i++) {
            expect(reg.register(1, `s${i}`, `Ctrl+Alt+F${i}`)).toEqual({ok: true});
        }
        expect(reg.register(1, 's17', 'Ctrl+Alt+F17')).toMatchObject({ok: false, error: 'limit-reached'});
        expect(reg.register(2, 'other', 'Ctrl+Alt+F18')).toEqual({ok: true});
    });

    it('unregister only affects the owner', () => {
        const {reg, registered} = make();
        reg.register(1, 'mute', 'Ctrl+Alt+M');
        reg.unregister(2, 'mute');
        expect(registered.has('ctrl+alt+m')).toBe(true);
        reg.unregister(1, 'mute');
        expect(registered.has('ctrl+alt+m')).toBe(false);
    });

    it('releaseOwner removes everything of that view only', () => {
        const {reg, registered} = make();
        reg.register(1, 'a', 'Ctrl+Alt+A');
        reg.register(1, 'b', 'Ctrl+Alt+B');
        reg.register(2, 'c', 'Ctrl+Alt+C');
        reg.releaseOwner(1);
        expect(registered.has('ctrl+alt+a')).toBe(false);
        expect(registered.has('ctrl+alt+b')).toBe(false);
        expect(registered.has('ctrl+alt+c')).toBe(true);

        // the accelerator can be reused by someone else afterwards
        expect(reg.register(3, 'a', 'Ctrl+Alt+A')).toEqual({ok: true});
    });

    it('dispose unregisters all', () => {
        const {reg, registered} = make();
        reg.register(1, 'a', 'Ctrl+Alt+A');
        reg.register(2, 'b', 'Ctrl+Alt+B');
        reg.dispose();
        expect(registered.size).toBe(0);
    });
});
