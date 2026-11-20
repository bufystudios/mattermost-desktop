// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {EventEmitter} from 'events';

import {connectSessionBus} from './portalBus';

function makeFakeDbus(opts: {failInvoke?: Error} = {}) {
    const connection = new EventEmitter();
    const signals = new EventEmitter();
    const bus = {
        name: undefined as string | undefined,
        connection,
        signals,
        mangle: (p: string, i: string, m: string) => `${p}:${i}:${m}`,
        invoke: jest.fn(async (msg: Record<string, unknown>) => {
            if (opts.failInvoke) {
                throw opts.failInvoke;
            }
            bus.name = ':1.77';
            return msg.member === 'Get' ? 2 : undefined;
        }),
        addMatch: jest.fn(async () => undefined),
        removeMatch: jest.fn(async () => undefined),
        close: jest.fn(async () => {
            connection.emit('close');
        }),
    };
    return {bus, module: {sessionBus: () => bus}};
}

describe('bufy/portalBus (dbus-native adapter)', () => {
    it('exposes the unique name once connected and forwards calls to the portal service', async () => {
        const {bus, module} = makeFakeDbus();
        const portal = await connectSessionBus({load: async () => module});
        expect(await portal.uniqueName()).toBe(':1.77');
        expect(await portal.call({path: '/p', iface: 'i.f', member: 'Get', signature: 'ss', body: ['a', 'b']})).toBe(2);
        expect(bus.invoke).toHaveBeenLastCalledWith(
            {destination: 'org.freedesktop.portal.Desktop', path: '/p', interface: 'i.f', member: 'Get', signature: 'ss', body: ['a', 'b']},
            expect.objectContaining({timeout: expect.any(Number)}),
        );
    });

    it('handles connection errors itself (dbus-native would otherwise crash the app with an unhandled error)', async () => {
        const {bus, module} = makeFakeDbus();
        const portal = await connectSessionBus({load: async () => module});
        const closed = jest.fn();
        portal.onClose(closed);
        expect(() => bus.connection.emit('error', new Error('EPIPE'))).not.toThrow();
        bus.connection.emit('close');
        expect(closed).toHaveBeenCalledWith(expect.objectContaining({message: 'EPIPE'}));
        closed.mockClear();
        portal.onClose(closed); // late subscriber is told immediately
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it('subscribes with a match rule pinned to the portal and unsubscribes cleanly', async () => {
        const {bus, module} = makeFakeDbus();
        const portal = await connectSessionBus({load: async () => module});
        const handler = jest.fn();
        const off = await portal.subscribe({path: '/org/freedesktop/portal/desktop', iface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated'}, handler);
        expect(bus.addMatch).toHaveBeenCalledWith("type='signal',sender='org.freedesktop.portal.Desktop',path='/org/freedesktop/portal/desktop',interface='org.freedesktop.portal.GlobalShortcuts',member='Activated'");

        bus.signals.emit('/org/freedesktop/portal/desktop:org.freedesktop.portal.GlobalShortcuts:Activated', ['/s', 'ptt', 1n, {}], 'osta{sv}');
        expect(handler).toHaveBeenCalledWith(['/s', 'ptt', 1n, {}]);

        off();
        bus.signals.emit('/org/freedesktop/portal/desktop:org.freedesktop.portal.GlobalShortcuts:Activated', ['/s', 'ptt']);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(bus.removeMatch).toHaveBeenCalledTimes(1);
    });

    it('a throwing signal handler does not break the connection', async () => {
        const {bus, module} = makeFakeDbus();
        const portal = await connectSessionBus({load: async () => module});
        await portal.subscribe({path: '/x', iface: 'i', member: 'm'}, () => {
            throw new Error('bug');
        });
        expect(() => bus.signals.emit('/x:i:m', [])).not.toThrow();
    });

    it('rejects (and closes) when the bus does not answer, so the portal backend reports "no portal"', async () => {
        const {bus, module} = makeFakeDbus({failInvoke: new Error('ECONNREFUSED')});
        await expect(connectSessionBus({load: async () => module})).rejects.toThrow('ECONNREFUSED');
        expect(bus.close).toHaveBeenCalled();
    });

    it('close() closes the connection and notifies once', async () => {
        const {bus, module} = makeFakeDbus();
        const portal = await connectSessionBus({load: async () => module});
        const closed = jest.fn();
        portal.onClose(closed);
        await portal.close();
        await portal.close();
        expect(bus.close).toHaveBeenCalledTimes(1);
        expect(closed).toHaveBeenCalledTimes(1);
    });
});
