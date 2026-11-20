// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: client for `org.freedesktop.portal.GlobalShortcuts` (xdg-desktop-portal), independent of the D-Bus
// library: everything talks to the small `PortalBus` interface (see portalBus.ts for the dbus-native adapter).
//
// Flow: [Registry.Register(app id)] -> CreateSession -> BindShortcuts -> Activated/Deactivated/ShortcutsChanged
// signals -> Session.Close. CreateSession/BindShortcuts/ListShortcuts answer asynchronously through a
// `org.freedesktop.portal.Request` object: we subscribe to its `Response` signal *before* making the call.

import {randomBytes} from 'crypto';

export const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
export const PORTAL_PATH = '/org/freedesktop/portal/desktop';
export const IFACE_GLOBAL_SHORTCUTS = 'org.freedesktop.portal.GlobalShortcuts';
export const IFACE_REQUEST = 'org.freedesktop.portal.Request';
export const IFACE_SESSION = 'org.freedesktop.portal.Session';
const IFACE_PROPERTIES = 'org.freedesktop.DBus.Properties';
const IFACE_REGISTRY = 'org.freedesktop.host.portal.Registry';

export type PortalCall = {
    path: string;
    iface: string;
    member: string;
    signature?: string;
    body?: unknown[];
};

export type SignalMatch = {path: string; iface: string; member: string};

export type PortalBus = {

    /** Unique connection name, e.g. `:1.42`. */
    uniqueName: () => Promise<string>;

    /** Calls a method on the portal service. Resolves to the reply value (undefined / single value / array). */
    call: (c: PortalCall) => Promise<unknown>;

    /** Subscribes to a signal of the portal service (match rule + listener); resolves to an unsubscribe function. */
    subscribe: (m: SignalMatch, handler: (args: unknown[]) => void) => Promise<() => void>;

    /** Called once when the connection is gone (also after `close()`). */
    onClose: (handler: (err?: Error) => void) => void;
    close: () => Promise<void>;
};

export type ShortcutSpec = {
    id: string;
    description: string;
    preferredTrigger?: string;
};

export type BoundShortcut = {
    id: string;
    description?: string;

    /** Human readable trigger as shown by the compositor, e.g. `Ctrl+Alt+P`. Empty when the user cleared it. */
    triggerDescription: string;
};

export class PortalError extends Error {
    code: string;
    dbusName?: string;

    constructor(code: string, message: string, dbusName?: string) {
        super(message);
        this.code = code;
        this.dbusName = dbusName;
    }
}

/** Response of a Request: 0 success, 1 cancelled by the user, 2 other failure. */
export type RequestResponse = {code: number; results: Record<string, unknown>};

export type PortalClientOptions = {
    appId: string;

    /** Timeout for CreateSession / ListShortcuts. */
    requestTimeoutMs?: number;

    /** Timeout for BindShortcuts: the user may have to confirm a dialog. */
    bindTimeoutMs?: number;
    randomToken?: () => string;
};

const DEFAULT_REQUEST_TIMEOUT = 10_000;
const DEFAULT_BIND_TIMEOUT = 120_000;

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `a(sa{sv})` -> list of bound shortcuts. Tolerates both `[id, {..}]` pairs and `{id, ...}` objects. */
export function parseShortcutList(value: unknown): BoundShortcut[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const out: BoundShortcut[] = [];
    for (const item of value) {
        if (!Array.isArray(item) || typeof item[0] !== 'string') {
            continue;
        }
        const props = asObject(item[1]);
        out.push({
            id: item[0],
            description: typeof props.description === 'string' ? props.description : undefined,
            triggerDescription: asString(props.trigger_description),
        });
    }
    return out;
}

export function isUnknownMethodError(err: unknown): boolean {
    const name = (err as {dbusName?: string})?.dbusName ?? '';
    return name.endsWith('.UnknownMethod') || name.endsWith('.UnknownInterface') || name.endsWith('.UnknownObject');
}

export class PortalClient {
    private bus: PortalBus;
    private opts: Required<Pick<PortalClientOptions, 'appId' | 'requestTimeoutMs' | 'bindTimeoutMs'>> & {randomToken: () => string};
    private senderToken?: string;

    constructor(bus: PortalBus, opts: PortalClientOptions) {
        this.bus = bus;
        this.opts = {
            appId: opts.appId,
            requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
            bindTimeoutMs: opts.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT,
            randomToken: opts.randomToken ?? (() => randomBytes(8).toString('hex')),
        };
    }

    /** Version of the GlobalShortcuts interface (0 / throws when it does not exist). */
    getVersion = async (): Promise<number> => {
        const v = await this.bus.call({
            path: PORTAL_PATH,
            iface: IFACE_PROPERTIES,
            member: 'Get',
            signature: 'ss',
            body: [IFACE_GLOBAL_SHORTCUTS, 'version'],
        });
        return Number(v) || 0;
    };

    /**
     * Tells the portal which app this connection is (`org.freedesktop.host.portal.Registry`, xdg-desktop-portal
     * >= 1.19). Older portals derive the id differently, so "no such method" is not an error.
     */
    registerAppId = async (): Promise<'registered' | 'unsupported' | 'already-registered'> => {
        try {
            await this.bus.call({
                path: PORTAL_PATH,
                iface: IFACE_REGISTRY,
                member: 'Register',
                signature: 'sa{sv}',
                body: [this.opts.appId, {}],
            });
            return 'registered';
        } catch (err) {
            if (isUnknownMethodError(err)) {
                return 'unsupported';
            }
            const msg = String((err as Error)?.message ?? err);
            if ((/already/i).test(msg)) {
                return 'already-registered';
            }
            throw toPortalError(err, 'app-id');
        }
    };

    createSession = async (): Promise<string> => {
        const sessionToken = `bufy_${this.opts.randomToken()}`;
        const res = await this.request(this.opts.requestTimeoutMs, (handleToken) => ({
            path: PORTAL_PATH,
            iface: IFACE_GLOBAL_SHORTCUTS,
            member: 'CreateSession',
            signature: 'a{sv}',
            body: [{handle_token: handleToken, session_handle_token: sessionToken}],
        }));
        if (res.code !== 0) {
            throw new PortalError(res.code === 1 ? 'cancelled' : 'failed', 'CreateSession was refused');
        }
        const handle = asString(res.results.session_handle);
        if (!handle) {
            throw new PortalError('failed', 'CreateSession returned no session handle');
        }
        return handle;
    };

    /** Binds all shortcuts of a session (allowed once per session). Resolves with what the user/compositor bound. */
    bindShortcuts = async (session: string, shortcuts: ShortcutSpec[]): Promise<BoundShortcut[]> => {
        const res = await this.request(this.opts.bindTimeoutMs, (handleToken) => ({
            path: PORTAL_PATH,
            iface: IFACE_GLOBAL_SHORTCUTS,
            member: 'BindShortcuts',
            signature: 'oa(sa{sv})sa{sv}',
            body: [
                session,
                shortcuts.map((s) => [s.id, s.preferredTrigger ? {description: s.description, preferred_trigger: s.preferredTrigger} : {description: s.description}]),
                '',
                {handle_token: handleToken},
            ],
        }));
        if (res.code === 1) {
            throw new PortalError('cancelled', 'The shortcut dialog was dismissed');
        }
        if (res.code !== 0) {
            throw new PortalError('failed', 'BindShortcuts failed');
        }
        return parseShortcutList(res.results.shortcuts);
    };

    listShortcuts = async (session: string): Promise<BoundShortcut[]> => {
        const res = await this.request(this.opts.requestTimeoutMs, (handleToken) => ({
            path: PORTAL_PATH,
            iface: IFACE_GLOBAL_SHORTCUTS,
            member: 'ListShortcuts',
            signature: 'oa{sv}',
            body: [session, {handle_token: handleToken}],
        }));
        if (res.code !== 0) {
            throw new PortalError('failed', 'ListShortcuts failed');
        }
        return parseShortcutList(res.results.shortcuts);
    };

    /** Opens the compositor's shortcut settings for this session (interface version >= 2). */
    configureShortcuts = async (session: string): Promise<void> => {
        await this.bus.call({
            path: PORTAL_PATH,
            iface: IFACE_GLOBAL_SHORTCUTS,
            member: 'ConfigureShortcuts',
            signature: 'osa{sv}',
            body: [session, '', {}],
        });
    };

    closeSession = async (session: string): Promise<void> => {
        try {
            await this.bus.call({path: session, iface: IFACE_SESSION, member: 'Close'});
        } catch {
            // already closed / connection gone: nothing to do
        }
    };

    onActivated = (handler: (session: string, id: string) => void) => this.signal('Activated', (a) => handler(asString(a[0]), asString(a[1])));
    onDeactivated = (handler: (session: string, id: string) => void) => this.signal('Deactivated', (a) => handler(asString(a[0]), asString(a[1])));
    onShortcutsChanged = (handler: (session: string, shortcuts: BoundShortcut[]) => void) => this.signal('ShortcutsChanged', (a) => handler(asString(a[0]), parseShortcutList(a[1])));

    /** The compositor closed the session on its own (e.g. the user revoked it). */
    onSessionClosed = async (session: string, handler: () => void): Promise<() => void> => {
        return this.bus.subscribe({path: session, iface: IFACE_SESSION, member: 'Closed'}, () => handler());
    };

    // ---- internals ----

    private signal = (member: string, handler: (args: unknown[]) => void): Promise<() => void> => {
        return this.bus.subscribe({path: PORTAL_PATH, iface: IFACE_GLOBAL_SHORTCUTS, member}, handler);
    };

    private getSenderToken = async () => {
        if (!this.senderToken) {
            // `:1.42` -> `1_42` (the portal derives Request paths from the caller's unique name)
            this.senderToken = (await this.bus.uniqueName()).replace(/^:/, '').replace(/\./g, '_');
        }
        return this.senderToken;
    };

    /** Runs a portal method that answers through a Request object and waits for its Response signal. */
    private request = async (timeoutMs: number, makeCall: (handleToken: string) => PortalCall): Promise<RequestResponse> => {
        const handleToken = `bufy_${this.opts.randomToken()}`;
        const expectedPath = `/org/freedesktop/portal/desktop/request/${await this.getSenderToken()}/${handleToken}`;

        let settle!: (r: RequestResponse) => void;
        const response = new Promise<RequestResponse>((resolve) => {
            settle = resolve;
        });
        const onResponse = (args: unknown[]) => settle({code: Number(args[0]), results: asObject(args[1])});
        const unsubscribers: Array<() => void> = [];
        unsubscribers.push(await this.bus.subscribe({path: expectedPath, iface: IFACE_REQUEST, member: 'Response'}, onResponse));

        let timer: NodeJS.Timeout | undefined;
        try {
            const handle = asString(await this.bus.call(makeCall(handleToken)));
            if (handle && handle !== expectedPath) {
                // very old portals: the Request lives at a different path than predicted
                unsubscribers.push(await this.bus.subscribe({path: handle, iface: IFACE_REQUEST, member: 'Response'}, onResponse));
            }
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    this.bus.call({path: handle || expectedPath, iface: IFACE_REQUEST, member: 'Close'}).catch(() => undefined);
                    reject(new PortalError('timeout', 'The portal did not answer in time'));
                }, timeoutMs);
            });
            return await Promise.race([response, timeout]);
        } catch (err) {
            throw toPortalError(err, 'call');
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
            unsubscribers.forEach((u) => u());
        }
    };
}

function toPortalError(err: unknown, fallbackCode: string): PortalError {
    if (err instanceof PortalError) {
        return err;
    }
    const dbusName = (err as {dbusName?: string})?.dbusName;
    const message = String((err as Error)?.message ?? err);
    let code = fallbackCode;
    if (dbusName?.endsWith('.NotAllowed')) {
        code = 'not-allowed';
    } else if (dbusName?.endsWith('.Failed') && (/app info not found/i).test(message)) {
        code = 'app-info-not-found';
    }
    return new PortalError(code, message, dbusName);
}
