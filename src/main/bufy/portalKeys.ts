// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: push-to-talk and global shortcuts on Linux Wayland through the xdg-desktop-portal GlobalShortcuts
// interface (the only sanctioned way: no client may read keys globally; the compositor owns the key assignment).
//
// Model:
// - ONE portal session (one private D-Bus connection) for the whole app, because the portal allows BindShortcuts only
//   once per session and the compositor stores the user's choices per app id + shortcut id. Shortcut ids are stable
//   (`ptt` and the plugin's own ids) so the compositor remembers them across restarts.
// - Registrations of all views are collected for a few ms and bound in one go. Changing the set closes the session and
//   binds the full set again (compositors restore already confirmed shortcuts without asking again).
// - `Activated`/`Deactivated` of `ptt` become down/up; for every other id `Activated` becomes a "shortcut" event.
// - A held key is released (`up`) whenever the binding goes away: unregister, view teardown, session loss, app quit.
// - No key is ever seen by us: only the compositor's "this shortcut fired" signal.

import {Logger} from 'common/log';

import {BUFY_APP_ID, defaultDesktopEntryEnv, ensureDesktopEntry} from './desktopEntry';
import type {EnsureResult} from './desktopEntry';
import {normalizeModifiers, parseKeyName} from './keys';
import {PortalClient, PortalError} from './portalClient';
import type {BoundShortcut, PortalBus, ShortcutSpec} from './portalClient';
import {triggerForAccelerator, triggerForKey} from './portalTrigger';
import {LIMITS} from './shared';
import type {BindingInfo, BufyResult, ModifierName, TriggerChange} from './shared';
import {checkAccelerator} from './validation';

const log = new Logger('Bufy.PortalKeys');

export const PTT_ID = 'ptt';
const NEGATIVE_PROBE_TTL_MS = 30_000;

export type PortalStatus = {available: boolean; reason?: string; version?: number};

export type PortalKeysDeps = {
    connect: () => Promise<PortalBus>;
    appId?: string;
    desktopEntry?: () => EnsureResult;
    bindDebounceMs?: number;
    bindTimeoutMs?: number;
    requestTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    randomToken?: () => string;
    emitTrigger: (ownerId: number, change: TriggerChange) => void;
};

type Entry = {
    portalId: string;
    kind: 'ptt' | 'shortcut';
    ownerId: number;
    id: string;
    description: string;
    preferredTrigger?: string;
    trigger?: string;
    isDown: boolean;
    onDown?: () => void;
    onUp?: () => void;
    onActivated?: () => void;
};

type Waiter = (r: BufyResult<BindingInfo>) => void;

type Connection = {
    bus: PortalBus;
    client: PortalClient;
    appIdReady: boolean;
    closed: boolean;
};

type Session = {
    path: string;
    conn: Connection;
    unsubscribe: Array<() => void>;
};

export class PortalKeys {
    private entries = new Map<string, Entry>();
    private waiters = new Map<string, Waiter[]>();

    // registrations whose BindShortcuts is in flight (the system dialog may be open)
    private inflight = new Map<string, Waiter[]>();
    private conn?: Connection;
    private session?: Session;
    private chain: Promise<void> = Promise.resolve();
    private bindTimer?: NodeJS.Timeout;
    private version = 0;
    private probeCache?: {status: PortalStatus; at: number};
    private disposed = false;

    private deps: PortalKeysDeps;
    private appId: string;

    constructor(deps: PortalKeysDeps) {
        this.deps = deps;
        this.appId = deps.appId ?? BUFY_APP_ID;
    }

    // ---- availability ----

    /** Is `org.freedesktop.portal.GlobalShortcuts` offered on the session bus? (positive results are cached) */
    getStatus = async (): Promise<PortalStatus> => {
        const now = (this.deps.now ?? Date.now)();
        const cached = this.probeCache;
        if (cached && (cached.status.available || now - cached.at < NEGATIVE_PROBE_TTL_MS)) {
            return cached.status;
        }
        const status = await this.probe();
        this.probeCache = {status, at: now};
        return status;
    };

    private probe = async (): Promise<PortalStatus> => {
        let bus: PortalBus | undefined;
        try {
            bus = this.conn && !this.conn.closed ? undefined : await this.deps.connect();
        } catch (err) {
            log.info('no session bus for the portal', {err: String(err)});
            return {available: false, reason: 'wayland-no-portal'};
        }
        try {
            const client = this.conn && !this.conn.closed ? this.conn.client : new PortalClient(bus!, {appId: this.appId});
            const version = await client.getVersion();
            if (version < 1) {
                return {available: false, reason: 'wayland-no-global-shortcuts'};
            }
            this.version = version;
            return {available: true, version};
        } catch (err) {
            const name = (err as {dbusName?: string})?.dbusName ?? '';
            const portalMissing = !name || (/ServiceUnknown|NameHasNoOwner|NoReply|Disconnected|Timeout/).test(name);
            log.info('GlobalShortcuts portal not usable', {err: String(err)});
            return {available: false, reason: portalMissing ? 'wayland-no-portal' : 'wayland-no-global-shortcuts'};
        } finally {
            await bus?.close().catch(() => undefined);
        }
    };

    // ---- registration ----

    registerPtt = (ownerId: number, keyName: string, modifiers: ModifierName[] | undefined, onDown: () => void, onUp: () => void): Promise<BufyResult<BindingInfo>> => {
        const parsed = parseKeyName(keyName);
        if (!parsed) {
            return Promise.resolve({ok: false, error: 'invalid-argument', message: `Unsupported key "${keyName}"`});
        }
        return this.register({
            portalId: PTT_ID,
            kind: 'ptt',
            ownerId,
            id: PTT_ID,
            description: 'Push to talk',
            preferredTrigger: triggerForKey(keyName, normalizeModifiers(modifiers)),
            isDown: false,
            onDown,
            onUp,
        });
    };

    unregisterPtt = (ownerId: number): BufyResult => this.unregister(ownerId, PTT_ID);

    registerShortcut = (ownerId: number, id: string, accelerator: string, onActivated: () => void): Promise<BufyResult<BindingInfo>> => {
        if (id === PTT_ID) {
            return Promise.resolve({ok: false, error: 'invalid-argument', message: `"${PTT_ID}" is reserved for push-to-talk`});
        }
        const check = checkAccelerator(accelerator);
        if (!check.ok) {
            return Promise.resolve({ok: false, error: 'invalid-argument', message: check.message});
        }
        const owned = [...this.entries.values()].filter((e) => e.ownerId === ownerId && e.kind === 'shortcut');
        if (owned.length >= LIMITS.maxShortcutsPerView && !owned.some((e) => e.id === id)) {
            return Promise.resolve({ok: false, error: 'limit-reached', message: `At most ${LIMITS.maxShortcutsPerView} shortcuts per view`});
        }
        return this.register({
            portalId: id,
            kind: 'shortcut',
            ownerId,
            id,
            description: id,
            preferredTrigger: triggerForAccelerator(accelerator),
            isDown: false,
            onActivated,
        });
    };

    unregisterShortcut = (ownerId: number, id: string): BufyResult => this.unregister(ownerId, id);

    /** Opens the compositor's shortcut settings (portal interface version 2). */
    configureShortcuts = async (): Promise<BufyResult> => {
        const session = this.session;
        if (!session) {
            return {ok: false, error: 'unsupported', message: 'No shortcut is registered yet: register one first'};
        }
        if (this.version < 2) {
            return {ok: false, error: 'unsupported', message: 'The portal is older than GlobalShortcuts v2 (no ConfigureShortcuts)'};
        }
        try {
            await session.conn.client.configureShortcuts(session.path);
            return {ok: true};
        } catch (err) {
            return {ok: false, error: 'registration-failed', message: String((err as Error)?.message ?? err)};
        }
    };

    releaseOwner = (ownerId: number) => {
        for (const e of [...this.entries.values()]) {
            if (e.ownerId === ownerId) {
                this.remove(e);
            }
        }
        this.afterRemoval();
    };

    /** Releases everything (app quit). The session is closed; the bus connection is closed right after. */
    dispose = () => {
        this.disposed = true;
        for (const e of [...this.entries.values()]) {
            this.remove(e);
        }
        clearTimeout(this.bindTimer);
        this.bindTimer = undefined;
        this.exclusive(() => this.closeAll());
    };

    hasPtt = (ownerId: number) => this.entries.get(PTT_ID)?.ownerId === ownerId;

    // ---- internals ----

    private register = (entry: Entry): Promise<BufyResult<BindingInfo>> => {
        if (this.disposed) {
            return Promise.resolve({ok: false, error: 'cancelled', message: 'Shutting down'});
        }
        const existing = this.entries.get(entry.portalId);
        if (existing && existing.ownerId !== entry.ownerId) {
            return Promise.resolve({ok: false, error: 'in-use', message: `"${entry.id}" is already registered by another view`});
        }

        if (existing && this.session && existing.trigger !== undefined && existing.preferredTrigger === entry.preferredTrigger && !this.waiters.has(entry.portalId)) {
            // Same request again (e.g. the plugin re-registers on reload of its settings): nothing to rebind.
            existing.onDown = entry.onDown;
            existing.onUp = entry.onUp;
            existing.onActivated = entry.onActivated;
            return Promise.resolve({ok: true, backend: 'portal', trigger: existing.trigger, requestedTrigger: existing.preferredTrigger});
        }

        if (existing?.isDown) {
            this.fireUp(existing);
        }
        this.entries.set(entry.portalId, entry);
        return new Promise((resolve) => {
            const list = this.waiters.get(entry.portalId) ?? [];
            let answered = false;
            list.push((r) => {
                if (!answered) {
                    answered = true;
                    resolve(r);
                }
            });
            this.waiters.set(entry.portalId, list);
            this.scheduleBind();
        });
    };

    private unregister = (ownerId: number, portalId: string): BufyResult => {
        const e = this.entries.get(portalId);
        if (e && e.ownerId === ownerId) {
            this.remove(e);
            this.afterRemoval();
        }
        return {ok: true};
    };

    /** Drops an entry: releases a held key and answers a registration that is still waiting. */
    private remove = (e: Entry) => {
        this.entries.delete(e.portalId);
        if (e.isDown) {
            this.fireUp(e);
        }
        const cancel = (map: Map<string, Waiter[]>) => {
            const waiting = map.get(e.portalId);
            map.delete(e.portalId);
            waiting?.forEach((w) => w({ok: false, error: 'cancelled', message: 'Unregistered before the system confirmed it'}));
        };
        cancel(this.waiters);
        cancel(this.inflight);
    };

    private afterRemoval = () => {
        if (this.entries.size === 0) {
            clearTimeout(this.bindTimer);
            this.bindTimer = undefined;
            this.exclusive(() => (this.entries.size === 0 ? this.closeAll() : undefined));
        }
    };

    private fireUp = (e: Entry) => {
        e.isDown = false;
        try {
            e.onUp?.();
        } catch (err) {
            log.warn('ptt release callback failed', {err});
        }
    };

    private exclusive = (fn: () => Promise<void> | void): Promise<void> => {
        const run = this.chain.then(fn);
        this.chain = run.catch((err) => log.error('portal operation failed', {err}));
        return run.catch(() => undefined);
    };

    private scheduleBind = () => {
        clearTimeout(this.bindTimer);
        this.bindTimer = setTimeout(() => {
            this.bindTimer = undefined;
            this.exclusive(this.rebind);
        }, this.deps.bindDebounceMs ?? 100);
    };

    private emitTrigger = (e: Entry, trigger: string) => {
        e.trigger = trigger;
        try {
            this.deps.emitTrigger(e.ownerId, {id: e.id, trigger});
        } catch (err) {
            log.warn('trigger change callback failed', {err});
        }
    };

    private rebind = async () => {
        const waiting = new Map(this.waiters);
        this.waiters.clear();
        this.inflight = waiting;
        const wanted = [...this.entries.values()];
        if (this.disposed || wanted.length === 0) {
            waiting.forEach((list) => list.forEach((w) => w({ok: false, error: 'cancelled'})));
            await this.closeAll();
            return;
        }

        // A bound session cannot be extended (BindShortcuts once per session): start over with the full set.
        this.releaseHeldKeys();
        await this.closeSession();

        const failAll = async (error: BufyResult<never> & {ok: false}) => {
            waiting.forEach((list) => list.forEach((w) => w(error)));
            for (const e of wanted) {
                if (this.entries.get(e.portalId) === e) {
                    this.entries.delete(e.portalId);
                    if (!waiting.has(e.portalId)) {
                        this.emitTrigger(e, ''); // was bound before, is not any more
                    }
                }
            }
            await this.closeAll();
        };

        try {
            const conn = await this.ensureConnection();
            const specs: ShortcutSpec[] = wanted.map((e) => ({id: e.portalId, description: e.description, preferredTrigger: e.preferredTrigger}));
            const path = await conn.client.createSession();
            const session: Session = {path, conn, unsubscribe: []};
            this.session = session;
            await this.listen(session);
            const bound = await conn.client.bindShortcuts(path, specs);
            if (this.session !== session) {
                // torn down (quit / connection lost) while the dialog was open
                waiting.forEach((list) => list.forEach((w) => w({ok: false, error: 'cancelled'})));
                return;
            }
            this.applyBound(wanted, bound, waiting);
            if (this.entries.size === 0) {
                await this.closeAll();
            }
        } catch (err) {
            log.warn('binding shortcuts through the portal failed', {err: String(err)});
            await failAll(this.toFailure(err));
        }
    };

    private applyBound = (wanted: Entry[], bound: BoundShortcut[], waiting: Map<string, Waiter[]>) => {
        const byId = new Map(bound.map((b) => [b.id, b]));
        for (const e of wanted) {
            if (this.entries.get(e.portalId) !== e) {
                continue; // unregistered meanwhile
            }
            const b = byId.get(e.portalId);
            const list = waiting.get(e.portalId);
            if (!b) {
                this.entries.delete(e.portalId);
                list?.forEach((w) => w({ok: false, error: 'cancelled', message: 'The shortcut was not bound (dismissed or no key assigned)'}));
                if (!list) {
                    this.emitTrigger(e, '');
                }
                continue;
            }
            const changed = e.trigger !== b.triggerDescription;
            e.trigger = b.triggerDescription;
            if (list) {
                list.forEach((w) => w({ok: true, backend: 'portal', trigger: b.triggerDescription, requestedTrigger: e.preferredTrigger}));
            } else if (changed) {
                this.emitTrigger(e, b.triggerDescription);
            }
        }
    };

    private toFailure = (err: unknown): BufyResult<never> & {ok: false} => {
        const message = String((err as Error)?.message ?? err);
        if (err instanceof PortalError) {
            switch (err.code) {
            case 'cancelled':
                return {ok: false, error: 'cancelled', message};
            case 'timeout':
                return {ok: false, error: 'timeout', message};
            case 'app-info-not-found':
            case 'app-id':
            case 'not-allowed':
                return {ok: false, error: 'registration-failed', message: `wayland-no-app-id: ${message}`};
            }
        }
        return {ok: false, error: 'registration-failed', message};
    };

    private ensureConnection = async (): Promise<Connection> => {
        if (this.conn && !this.conn.closed) {
            return this.conn;
        }
        const bus = await this.deps.connect();
        const conn: Connection = {
            bus,
            client: new PortalClient(bus, {
                appId: this.appId,
                bindTimeoutMs: this.deps.bindTimeoutMs,
                requestTimeoutMs: this.deps.requestTimeoutMs,
                randomToken: this.deps.randomToken,
            }),
            appIdReady: false,
            closed: false,
        };
        bus.onClose(() => {
            conn.closed = true;
            if (this.conn === conn) {
                this.handleConnectionLost();
            }
        });
        this.conn = conn;
        try {
            await this.registerAppId(conn);
            const version = await conn.client.getVersion();
            this.version = version;
        } catch (err) {
            await this.closeConnection();
            throw err;
        }
        return conn;
    };

    private registerAppId = async (conn: Connection) => {
        const ensured = (this.deps.desktopEntry ?? (() => ensureDesktopEntry(this.appId, defaultDesktopEntryEnv())))();
        if (ensured.state === 'failed') {
            log.warn('no desktop entry for the app id', {appId: this.appId, error: ensured.error});
        }
        const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        let attempt = 0;
        for (;;) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const res = await conn.client.registerAppId();
                log.info('portal app id', {appId: this.appId, result: res});
                conn.appIdReady = true;
                return;
            } catch (err) {
                // a freshly written .desktop file is picked up asynchronously by the portal
                if (!(err instanceof PortalError && err.code === 'app-info-not-found' && attempt < 4)) {
                    throw err;
                }
            }
            attempt++;
            // eslint-disable-next-line no-await-in-loop
            await sleep(400);
        }
    };

    private listen = async (session: Session) => {
        const {client} = session.conn;
        const mine = (s: string) => this.session === session && s === session.path;
        session.unsubscribe.push(
            await client.onActivated((s, id) => {
                if (!mine(s)) {
                    return;
                }
                const e = this.entries.get(id);
                if (e?.kind === 'ptt' && !e.isDown) {
                    e.isDown = true;
                    e.onDown?.();
                } else if (e?.kind === 'shortcut') {
                    e.onActivated?.();
                }
            }),
            await client.onDeactivated((s, id) => {
                const e = this.entries.get(id);
                if (mine(s) && e?.kind === 'ptt' && e.isDown) {
                    this.fireUp(e);
                }
            }),
            await client.onShortcutsChanged((s, list) => {
                if (!mine(s)) {
                    return;
                }
                for (const b of list) {
                    const e = this.entries.get(b.id);
                    if (e && e.trigger !== b.triggerDescription) {
                        this.emitTrigger(e, b.triggerDescription);
                    }
                }
            }),
            await client.onSessionClosed(session.path, () => {
                if (this.session === session) {
                    log.info('the compositor closed the shortcuts session');
                    this.handleConnectionLost();
                }
            }),
        );
    };

    private releaseHeldKeys = () => {
        for (const e of this.entries.values()) {
            if (e.isDown) {
                this.fireUp(e);
            }
        }
    };

    /** The session/connection vanished under us: nothing is bound any more, tell the owners. */
    private handleConnectionLost = () => {
        this.releaseHeldKeys();
        const lost = [...this.entries.values()];
        this.entries.clear();
        for (const e of lost) {
            this.emitTrigger(e, '');
        }
        this.waiters.forEach((list) => list.forEach((w) => w({ok: false, error: 'cancelled', message: 'Portal session lost'})));
        this.waiters.clear();
        this.session = undefined;
        this.conn = undefined;
    };

    private closeSession = async () => {
        const s = this.session;
        if (!s) {
            return;
        }
        this.session = undefined;
        s.unsubscribe.forEach((u) => u());
        if (!s.conn.closed) {
            await s.conn.client.closeSession(s.path);
        }
    };

    private closeConnection = async () => {
        const c = this.conn;
        this.conn = undefined;
        if (c && !c.closed) {
            c.closed = true;
            await c.bus.close().catch(() => undefined);
        }
    };

    private closeAll = async () => {
        this.releaseHeldKeys();
        await this.closeSession();
        await this.closeConnection();
    };
}
