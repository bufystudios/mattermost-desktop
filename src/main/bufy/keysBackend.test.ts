// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {GlobalKeys} from './globalKeys';
import type {HookLike} from './globalKeys';
import {KeysBackend} from './keysBackend';
import {PortalKeys} from './portalKeys';
import {ShortcutRegistry} from './shortcuts';
import type {ShortcutBackend} from './shortcuts';
import {FakePortal} from './testing/fakePortalBus';

function make(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'linux', portal = new FakePortal()) {
    const hook = {on: jest.fn(), start: jest.fn(), stop: jest.fn()};
    const loadHook = jest.fn().mockResolvedValue(hook as unknown as HookLike);
    const uiohook = new GlobalKeys({platform, env, loadHook, isAccessibilityTrusted: () => true});
    const registered = new Map<string, VoidFunction>();
    const electronShortcuts: ShortcutBackend = {
        register: jest.fn((a: string, cb: () => void) => {
            registered.set(a, cb);
            return true;
        }),
        unregister: jest.fn((a: string) => registered.delete(a)),
        isRegistered: (a: string) => registered.has(a),
    };
    const shortcuts = new ShortcutRegistry(electronShortcuts, jest.fn());
    const connect = jest.fn().mockImplementation(async () => {
        portal.connectionClosed = false; // every connect() is a fresh connection
        return portal.bus;
    });
    const portalKeys = new PortalKeys({
        connect,
        desktopEntry: () => ({appId: 'x', state: 'installed'}),
        bindDebounceMs: 1,
        sleep: async () => undefined,
        emitTrigger: jest.fn(),
    });
    const backend = new KeysBackend({platform, env, uiohook, portal: portalKeys, shortcuts});
    return {backend, portal, hook, loadHook, connect, electronShortcuts, portalKeys};
}

const WAYLAND = {XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0'};

describe('bufy/KeysBackend selection', () => {
    describe('X11 / Windows / macOS keep the native hook and Electron globalShortcut', () => {
        it.each<[string, NodeJS.Platform, NodeJS.ProcessEnv]>([
            ['x11', 'linux', {XDG_SESSION_TYPE: 'x11', DISPLAY: ':0'}],
            ['win32', 'win32', {}],
            ['darwin', 'darwin', {}],
        ])('%s -> uiohook, no D-Bus traffic', async (_n, platform, env) => {
            const {backend, connect, hook} = make(env, platform);
            expect(await backend.getStatus()).toMatchObject({available: true, backend: 'uiohook'});
            expect(await backend.registerPtt(1, 'Space', undefined, jest.fn(), jest.fn())).toEqual({ok: true, backend: 'uiohook'});
            expect(hook.start).toHaveBeenCalled();
            expect(await backend.registerShortcut(1, 'm', 'Ctrl+Alt+M', jest.fn())).toEqual({ok: true, backend: 'electron'});
            expect(backend.keyCaptureSupported).toBe(true);
            expect(connect).not.toHaveBeenCalled();
            backend.dispose();
        });
    });

    describe('Wayland', () => {
        it.each([
            ['XDG_SESSION_TYPE', {XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0'}],
            ['WAYLAND_DISPLAY', {WAYLAND_DISPLAY: 'wayland-0'}],
        ])('selects the portal backend when GlobalShortcuts is offered (%s)', async (_n, env) => {
            const {backend, loadHook} = make(env);
            expect(await backend.getStatus()).toEqual({available: true, permission: 'not-required', backend: 'portal'});
            expect(loadHook).not.toHaveBeenCalled(); // the native hook is never loaded on Wayland
            expect(backend.keyCaptureSupported).toBe(false);
        });

        it('routes push-to-talk and toggles to the portal and never to Electron globalShortcut / uiohook', async () => {
            const {backend, portal, hook, electronShortcuts} = make(WAYLAND);
            const [ptt, mute] = await Promise.all([
                backend.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn()),
                backend.registerShortcut(1, 'toggle-mute', 'CommandOrControl+Shift+M', jest.fn()),
            ]);
            expect(ptt).toMatchObject({ok: true, backend: 'portal', trigger: 'F13'});
            expect(mute).toMatchObject({ok: true, backend: 'portal', trigger: 'CTRL+SHIFT+m'});
            expect(portal.sessions).toHaveLength(1); // one shared session: no double registration
            expect(electronShortcuts.register).not.toHaveBeenCalled();
            expect(hook.start).not.toHaveBeenCalled();
            backend.dispose();
        });

        it.each([
            ['no portal / no session bus', 'wayland-no-portal'],
            ['portal without GlobalShortcuts', 'wayland-no-global-shortcuts'],
        ])('stays unsupported with a precise reason: %s', async (name, reason) => {
            const portal = new FakePortal();
            let b: ReturnType<typeof make>;
            if (reason === 'wayland-no-portal') {
                b = make(WAYLAND, 'linux', portal);
                (b.connect as jest.Mock).mockRejectedValue(new Error('no bus'));
            } else {
                portal.version = 0;
                b = make(WAYLAND, 'linux', portal);
            }
            expect(await b.backend.getStatus()).toEqual({available: false, reason, permission: 'not-required', backend: null});
            expect(await b.backend.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn())).toEqual({ok: false, error: 'unsupported', message: reason});
            expect(await b.backend.registerShortcut(1, 'm', 'Ctrl+Alt+M', jest.fn())).toEqual({ok: false, error: 'unsupported', message: reason});
            expect(b.electronShortcuts.register).not.toHaveBeenCalled();
        });

        it('captureNextKey is unsupported-on-wayland', async () => {
            const {backend} = make(WAYLAND);
            expect(await backend.captureNextKey(1)).toMatchObject({ok: false, error: 'unsupported-on-wayland'});
        });

        it('unregister / release / dispose reach the portal', async () => {
            const {backend, portal} = make(WAYLAND);
            const onUp = jest.fn();
            await backend.registerPtt(1, 'F13', undefined, jest.fn(), onUp);
            portal.activate('ptt');
            backend.unregisterPtt(1);
            expect(onUp).toHaveBeenCalledTimes(1);

            await backend.registerShortcut(2, 'm', 'Ctrl+Alt+M', jest.fn());
            backend.releaseOwner(2);
            await new Promise((r) => setTimeout(r, 10));
            expect(portal.closed).toBe(true);
        });

        it('openShortcutSettings is portal-only', async () => {
            const x11 = make({XDG_SESSION_TYPE: 'x11', DISPLAY: ':0'});
            expect(await x11.backend.openShortcutSettings()).toMatchObject({ok: false, error: 'unsupported'});
            const w = make(WAYLAND);
            await w.backend.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            expect(await w.backend.openShortcutSettings()).toEqual({ok: true});
            w.backend.dispose();
        });
    });
});
