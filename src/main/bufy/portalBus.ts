// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: `PortalBus` on top of `dbus-native` (MIT, pure JavaScript, no native add-on).
// The library is loaded lazily so a missing/broken module only disables the portal backend.

import {PORTAL_NAME} from './portalClient';
import type {PortalBus, PortalCall, SignalMatch} from './portalClient';

type DbusModule = {
    sessionBus: (opts?: Record<string, unknown>) => DbusBus;
};

type SignalListener = (body: unknown[], signature?: string) => void;

// The small part of dbus-native's MessageBus we use.
type DbusBus = {
    connection: {on: (event: string, listener: (...args: unknown[]) => void) => unknown};
    signals: {on: (key: string, l: SignalListener) => unknown; off: (key: string, l: SignalListener) => unknown};
    mangle: (path: string, iface: string, member: string) => string;
    invoke: (msg: Record<string, unknown>, options?: Record<string, unknown>) => PromiseLike<unknown>;
    addMatch: (rule: string) => PromiseLike<unknown>;
    removeMatch: (rule: string) => PromiseLike<unknown>;
    close: () => Promise<void>;
};

export type ConnectOptions = {
    load?: () => Promise<DbusModule>;
    callTimeoutMs?: number;
};

const DEFAULT_CALL_TIMEOUT = 15_000;

async function loadDbus(): Promise<DbusModule> {
    const mod = await import('dbus-native') as unknown as DbusModule & {default?: DbusModule};
    return typeof mod.sessionBus === 'function' ? mod : mod.default!;
}

function matchRule(m: SignalMatch) {
    // `sender` pins the rule to the portal service, so signals sent by another bus client are never delivered.
    return `type='signal',sender='${PORTAL_NAME}',path='${m.path}',interface='${m.iface}',member='${m.member}'`;
}

/** Opens a private connection to the session bus. Rejects when there is no session bus. */
export async function connectSessionBus(options: ConnectOptions = {}): Promise<PortalBus> {
    const dbus = await (options.load ?? loadDbus)();
    const bus = dbus.sessionBus();
    const timeout = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT;

    let closed = false;
    let closeError: Error | undefined;
    const closeHandlers: Array<(err?: Error) => void> = [];
    const notifyClosed = () => {
        if (closed) {
            return;
        }
        closed = true;
        closeHandlers.splice(0).forEach((h) => h(closeError));
    };

    // dbus-native never listens for 'error' itself: without a listener a socket error would take the app down.
    bus.connection.on('error', (err) => {
        closeError = err instanceof Error ? err : new Error(String(err));
    });
    bus.connection.on('close', notifyClosed);
    bus.connection.on('end', notifyClosed);

    const invoke = (msg: Record<string, unknown>) => Promise.resolve(bus.invoke(msg, {timeout}));

    // Wait for the connection (Hello) before handing the bus out, so a missing bus fails here.
    await invoke({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'GetNameOwner',
        signature: 's',
        body: ['org.freedesktop.DBus'],
    }).catch(async (err) => {
        await bus.close().catch(() => undefined);
        throw err;
    });

    const bufyBus: PortalBus = {
        uniqueName: async () => {
            const name = (bus as unknown as {name?: string}).name; // set by the Hello reply
            if (!name) {
                throw new Error('D-Bus unique name unavailable');
            }
            return name;
        },

        call: (c: PortalCall) => invoke({
            destination: PORTAL_NAME,
            path: c.path,
            interface: c.iface,
            member: c.member,
            signature: c.signature,
            body: c.body,
        }),

        subscribe: async (m, handler) => {
            const key = bus.mangle(m.path, m.iface, m.member);
            const listener: SignalListener = (body) => {
                try {
                    handler(Array.isArray(body) ? body : [body]);
                } catch {
                    // a misbehaving handler must not break the connection
                }
            };
            bus.signals.on(key, listener);
            const rule = matchRule(m);
            try {
                await bus.addMatch(rule);
            } catch (err) {
                bus.signals.off(key, listener);
                throw err;
            }
            return () => {
                bus.signals.off(key, listener);
                if (!closed) {
                    Promise.resolve(bus.removeMatch(rule)).catch(() => undefined);
                }
            };
        },

        onClose: (handler) => {
            if (closed) {
                handler(closeError);
            } else {
                closeHandlers.push(handler);
            }
        },

        close: async () => {
            if (closed) {
                return;
            }
            try {
                await bus.close();
            } finally {
                notifyClosed();
            }
        },
    };
    return bufyBus;
}
