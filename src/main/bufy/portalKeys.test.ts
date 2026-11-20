// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {PortalKeys} from './portalKeys';
import type {PortalKeysDeps} from './portalKeys';
import {FakePortal} from './testing/fakePortalBus';

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

function make(portal = new FakePortal(), overrides: Partial<PortalKeysDeps> = {}) {
    const triggers: Array<[number, {id: string; trigger: string}]> = [];
    const connect = jest.fn().mockImplementation(async () => {
        portal.connectionClosed = false;
        return portal.bus;
    });
    const keys = new PortalKeys({
        connect,
        desktopEntry: () => ({appId: 'com.Mattermost.Desktop', state: 'installed'}),
        bindDebounceMs: 1,
        sleep: async () => undefined,
        randomToken: (() => {
            let n = 0;
            return () => `t${++n}`;
        })(),
        emitTrigger: (ownerId, change) => triggers.push([ownerId, change]),
        ...overrides,
    });
    return {keys, portal, triggers, connect};
}

describe('bufy/PortalKeys', () => {
    describe('availability', () => {
        it('is available when GlobalShortcuts exists, and caches the answer', async () => {
            const {keys, portal, connect} = make();
            expect(await keys.getStatus()).toEqual({available: true, version: 2});
            expect(await keys.getStatus()).toEqual({available: true, version: 2});
            expect(connect).toHaveBeenCalledTimes(1);
            expect(portal.closed).toBe(true); // probe connection is not kept
        });

        it('reports wayland-no-portal when the session bus is unreachable', async () => {
            const {keys} = make(undefined, {connect: jest.fn().mockRejectedValue(new Error('ENOENT'))});
            expect(await keys.getStatus()).toEqual({available: false, reason: 'wayland-no-portal'});
        });

        it('reports wayland-no-portal when the portal service is not running', async () => {
            const portal = new FakePortal();
            portal.bus.call = jest.fn().mockRejectedValue(Object.assign(new Error('x'), {dbusName: 'org.freedesktop.DBus.Error.ServiceUnknown'}));
            const {keys} = make(portal);
            expect(await keys.getStatus()).toEqual({available: false, reason: 'wayland-no-portal'});
        });

        it('reports wayland-no-global-shortcuts when the interface is missing (e.g. old portal / GNOME < 48)', async () => {
            const portal = new FakePortal();
            portal.version = 0;
            const {keys} = make(portal);
            expect(await keys.getStatus()).toEqual({available: false, reason: 'wayland-no-global-shortcuts'});
        });

        it('retries a negative answer later, never caches it forever', async () => {
            let now = 0;
            const portal = new FakePortal();
            portal.version = 0;
            const {keys} = make(portal, {now: () => now});
            expect((await keys.getStatus()).available).toBe(false);
            portal.version = 1;
            expect((await keys.getStatus()).available).toBe(false); // still inside the TTL
            now += 31_000;
            expect(await keys.getStatus()).toEqual({available: true, version: 1});
        });
    });

    describe('session flow', () => {
        it('registers the app id, creates a session and binds ptt with the preferred trigger', async () => {
            const {keys, portal} = make();
            const res = await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            expect(res).toEqual({ok: true, backend: 'portal', trigger: 'F13', requestedTrigger: 'F13'});
            expect(portal.members()).toEqual(['Register', 'Get', 'CreateSession', 'BindShortcuts']);
            expect(portal.calls[0]).toMatchObject({iface: 'org.freedesktop.host.portal.Registry', body: ['com.Mattermost.Desktop', {}]});
            expect(portal.binds).toEqual([[{id: 'ptt', description: 'Push to talk', preferred_trigger: 'F13'}]]);
            keys.dispose();
        });

        it('resolves with what the compositor actually bound, not what was requested', async () => {
            const portal = new FakePortal();
            portal.triggerFor = () => 'Meta+Shift+V'; // the user picked another key in the KDE dialog
            const {keys} = make(portal);
            expect(await keys.registerPtt(1, 'KeyV', ['ctrl'], jest.fn(), jest.fn())).toEqual({ok: true, backend: 'portal', trigger: 'Meta+Shift+V', requestedTrigger: 'CTRL+v'});
            keys.dispose();
        });

        it('binds mouse buttons without a suggested trigger (the portal cannot express them)', async () => {
            const {keys, portal} = make();
            const res = await keys.registerPtt(1, 'Mouse4', undefined, jest.fn(), jest.fn());
            expect(res).toMatchObject({ok: true, trigger: ''});
            expect(portal.binds[0][0]).not.toHaveProperty('preferred_trigger');
            keys.dispose();
        });

        it('batches registrations made together into ONE session and ONE BindShortcuts', async () => {
            const {keys, portal} = make();
            const [ptt, mute, deafen] = await Promise.all([
                keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn()),
                keys.registerShortcut(1, 'toggle-mute', 'CommandOrControl+Shift+M', jest.fn()),
                keys.registerShortcut(1, 'toggle-deafen', 'CommandOrControl+Shift+D', jest.fn()),
            ]);
            expect([ptt.ok, mute.ok, deafen.ok]).toEqual([true, true, true]);
            expect(portal.sessions).toHaveLength(1);
            expect(portal.binds).toHaveLength(1);
            expect(portal.binds[0].map((s) => [s.id, s.preferred_trigger])).toEqual([
                ['ptt', 'F13'],
                ['toggle-mute', 'CTRL+SHIFT+m'],
                ['toggle-deafen', 'CTRL+SHIFT+d'],
            ]);
            keys.dispose();
        });

        it('a later registration closes the old session and binds the full set again (BindShortcuts once per session)', async () => {
            const {keys, portal} = make();
            await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            await keys.registerShortcut(1, 'toggle-mute', 'Ctrl+Alt+M', jest.fn());
            expect(portal.sessions).toHaveLength(2);
            expect(portal.closedSessions).toEqual([portal.sessions[0]]);
            expect(portal.binds[1].map((s) => s.id)).toEqual(['ptt', 'toggle-mute']);
            expect(portal.members().filter((m) => m === 'Register')).toHaveLength(1); // same connection
            keys.dispose();
        });

        it('re-registering the same thing is a no-op that returns the bound trigger', async () => {
            const {keys, portal} = make();
            await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            const again = await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            expect(again).toMatchObject({ok: true, trigger: 'F13'});
            expect(portal.sessions).toHaveLength(1);
            keys.dispose();
        });

        it('retries the app id registration while the portal has not seen the new .desktop file yet', async () => {
            const portal = new FakePortal();
            portal.register = 'no-app-info';
            const sleep = jest.fn().mockImplementation(async () => {
                if (sleep.mock.calls.length === 2) {
                    portal.register = 'ok';
                }
            });
            const {keys} = make(portal, {sleep});
            expect(await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn())).toMatchObject({ok: true});
            expect(sleep).toHaveBeenCalledTimes(2);
            keys.dispose();
        });

        it('fails with a precise reason when no desktop entry can be found', async () => {
            const portal = new FakePortal();
            portal.register = 'no-app-info';
            const {keys} = make(portal);
            const res = await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            expect(res).toMatchObject({ok: false, error: 'registration-failed'});
            expect((res as {message: string}).message).toContain('wayland-no-app-id');
            expect(portal.closed).toBe(true); // nothing left open
            expect(portal.sessions).toHaveLength(0);
        });

        it('works with an old portal that has no Registry interface', async () => {
            const portal = new FakePortal();
            portal.register = 'unsupported';
            const {keys} = make(portal);
            expect(await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn())).toMatchObject({ok: true});
            keys.dispose();
        });

        it('a dismissed dialog is `cancelled` and leaves nothing behind', async () => {
            const portal = new FakePortal();
            portal.dialog = 'dismiss';
            const {keys} = make(portal);
            expect(await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn())).toMatchObject({ok: false, error: 'cancelled'});
            await tick();
            expect(portal.closedSessions).toEqual(portal.sessions);
            expect(portal.closed).toBe(true);
            expect(keys.hasPtt(1)).toBe(false);
        });

        it('only some shortcuts bound: the others are cancelled individually', async () => {
            const portal = new FakePortal();
            portal.dialog = 'bind-nothing';
            const {keys} = make(portal);
            const res = await keys.registerShortcut(1, 'toggle-mute', 'Ctrl+Alt+M', jest.fn());
            expect(res).toMatchObject({ok: false, error: 'cancelled'});
            await tick();
            expect(portal.closed).toBe(true);
        });

        it('rejects the reserved id, duplicates across views, bad accelerators and unknown keys without touching D-Bus', async () => {
            const {keys, portal} = make();
            expect(await keys.registerShortcut(1, 'ptt', 'Ctrl+Alt+M', jest.fn())).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(await keys.registerShortcut(1, 'x', 'M', jest.fn())).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(await keys.registerPtt(1, 'Nope', undefined, jest.fn(), jest.fn())).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(portal.calls).toHaveLength(0);

            await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            expect(await keys.registerPtt(2, 'F14', undefined, jest.fn(), jest.fn())).toMatchObject({ok: false, error: 'in-use'});
            keys.dispose();
        });
    });

    describe('event mapping', () => {
        it('Activated/Deactivated of ptt become down/up once per press', async () => {
            const {keys, portal} = make();
            const onDown = jest.fn();
            const onUp = jest.fn();
            await keys.registerPtt(1, 'F13', undefined, onDown, onUp);

            portal.activate('ptt');
            portal.activate('ptt'); // compositor key repeat must not double fire
            expect(onDown).toHaveBeenCalledTimes(1);
            portal.deactivate('ptt');
            portal.deactivate('ptt');
            expect(onUp).toHaveBeenCalledTimes(1);
            keys.dispose();
        });

        it('Activated of a toggle shortcut fires it, Deactivated is ignored, other ids and sessions are ignored', async () => {
            const {keys, portal} = make();
            const mute = jest.fn();
            const onDown = jest.fn();
            await Promise.all([
                keys.registerPtt(1, 'F13', undefined, onDown, jest.fn()),
                keys.registerShortcut(1, 'toggle-mute', 'Ctrl+Alt+M', mute),
            ]);
            portal.activate('toggle-mute');
            portal.deactivate('toggle-mute');
            portal.activate('unknown');
            portal.activate('ptt', '/some/other/session');
            expect(mute).toHaveBeenCalledTimes(1);
            expect(onDown).not.toHaveBeenCalled();
            keys.dispose();
        });

        it('ShortcutsChanged updates the trigger and tells the owner (user changed the key in system settings)', async () => {
            const {keys, portal, triggers} = make();
            await keys.registerPtt(7, 'F13', undefined, jest.fn(), jest.fn());
            portal.shortcutsChanged([['ptt', {trigger_description: 'Ctrl+Alt+P'}]]);
            portal.shortcutsChanged([['ptt', {trigger_description: 'Ctrl+Alt+P'}]]); // unchanged: no second event
            expect(triggers).toEqual([[7, {id: 'ptt', trigger: 'Ctrl+Alt+P'}]]);
            keys.dispose();
        });
    });

    describe('cleanup', () => {
        it('unregistering the last binding releases a held key, closes the session and the connection', async () => {
            const {keys, portal} = make();
            const onUp = jest.fn();
            await keys.registerPtt(1, 'F13', undefined, jest.fn(), onUp);
            portal.activate('ptt');
            keys.unregisterPtt(1);
            expect(onUp).toHaveBeenCalledTimes(1);
            await tick();
            expect(portal.closedSessions).toEqual(portal.sessions);
            expect(portal.closed).toBe(true);
            portal.deactivate('ptt'); // late signal: nothing happens
            expect(onUp).toHaveBeenCalledTimes(1);
        });

        it('releaseOwner (view teardown) only drops that owner; the session stays for the others', async () => {
            const {keys, portal} = make();
            const upA = jest.fn();
            await Promise.all([
                keys.registerPtt(1, 'F13', undefined, jest.fn(), upA),
                keys.registerShortcut(2, 'toggle-mute', 'Ctrl+Alt+M', jest.fn()),
            ]);
            portal.activate('ptt');
            keys.releaseOwner(1);
            expect(upA).toHaveBeenCalledTimes(1);
            await tick();
            expect(portal.closedSessions).toEqual([]);
            keys.releaseOwner(2);
            await tick();
            expect(portal.closedSessions).toEqual(portal.sessions);
            expect(portal.closed).toBe(true);
        });

        it('dispose (app quit) sends pttUp if held, closes the session and the bus', async () => {
            const {keys, portal} = make();
            const onUp = jest.fn();
            await keys.registerPtt(1, 'F13', undefined, jest.fn(), onUp);
            portal.activate('ptt');
            keys.dispose();
            expect(onUp).toHaveBeenCalledTimes(1);
            await tick();
            expect(portal.closedSessions).toEqual(portal.sessions);
            expect(portal.closed).toBe(true);
            expect(await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn())).toMatchObject({ok: false, error: 'cancelled'});
        });

        it('a rebind while the key is held releases it first', async () => {
            const {keys, portal} = make();
            const onUp = jest.fn();
            await keys.registerPtt(1, 'F13', undefined, jest.fn(), onUp);
            portal.activate('ptt');
            await keys.registerShortcut(1, 'toggle-mute', 'Ctrl+Alt+M', jest.fn());
            expect(onUp).toHaveBeenCalledTimes(1);
            keys.dispose();
        });

        it('unregistering while the dialog is still open cancels the waiting registration', async () => {
            const portal = new FakePortal();
            let release!: () => void;
            portal.holdBind = new Promise<void>((r) => {
                release = r;
            });
            const {keys} = make(portal);
            const pending = keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            await tick(20);
            keys.unregisterPtt(1);
            expect(await pending).toMatchObject({ok: false, error: 'cancelled'});
            release();
            await tick();
            expect(keys.hasPtt(1)).toBe(false);
        });

        it('the compositor closing the session releases the key and tells the owner the trigger is gone', async () => {
            const {keys, portal, triggers} = make();
            const onUp = jest.fn();
            await keys.registerPtt(3, 'F13', undefined, jest.fn(), onUp);
            portal.activate('ptt');
            portal.closeSessionFromCompositor();
            expect(onUp).toHaveBeenCalledTimes(1);
            expect(triggers).toEqual([[3, {id: 'ptt', trigger: ''}]]);
            expect(keys.hasPtt(3)).toBe(false);

            // and a fresh registration works again on a new connection
            expect(await keys.registerPtt(3, 'F13', undefined, jest.fn(), jest.fn())).toMatchObject({ok: true});
            keys.dispose();
        });

        it('losing the D-Bus connection behaves like a closed session', async () => {
            const {keys, portal, triggers} = make();
            const onUp = jest.fn();
            await keys.registerPtt(3, 'F13', undefined, jest.fn(), onUp);
            portal.activate('ptt');
            portal.loseConnection(new Error('EPIPE'));
            expect(onUp).toHaveBeenCalledTimes(1);
            expect(triggers).toEqual([[3, {id: 'ptt', trigger: ''}]]);
        });
    });

    describe('configureShortcuts', () => {
        it('needs a session and interface version 2', async () => {
            const portal = new FakePortal();
            const {keys} = make(portal);
            expect(await keys.configureShortcuts()).toMatchObject({ok: false, error: 'unsupported'});
            await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            expect(await keys.configureShortcuts()).toEqual({ok: true});
            expect(portal.members()).toContain('ConfigureShortcuts');
            keys.dispose();
        });

        it('reports unsupported on a v1 portal', async () => {
            const portal = new FakePortal();
            portal.version = 1;
            const {keys} = make(portal);
            await keys.registerPtt(1, 'F13', undefined, jest.fn(), jest.fn());
            expect(await keys.configureShortcuts()).toMatchObject({ok: false, error: 'unsupported'});
            keys.dispose();
        });
    });
});
