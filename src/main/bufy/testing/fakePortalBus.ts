// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Test helper: an in-memory stand-in for the xdg-desktop-portal GlobalShortcuts service on a D-Bus connection.

import type {PortalBus, PortalCall, SignalMatch} from '../portalClient';

type Handler = (args: unknown[]) => void;

export type FakeBoundShortcut = [string, {description?: string; trigger_description: string}];

export class FakePortal {
    uniqueName = ':1.42';

    /** `GlobalShortcuts.version` (0 = interface missing). */
    version = 2;

    /** `Registry.Register`: 'ok' | 'unsupported' (old portal) | 'no-app-info' (no .desktop file). */
    register: 'ok' | 'unsupported' | 'no-app-info' = 'ok';

    /** What the user does in the compositor dialog. */
    dialog: 'accept' | 'dismiss' | 'bind-nothing' = 'accept';

    /** Overrides the trigger the compositor binds (e.g. the user picked another key). Default: the preferred trigger. */
    triggerFor: (id: string, preferred?: string) => string = (_id, preferred) => preferred ?? '';

    /** When set, BindShortcuts only answers once this promise resolves (a dialog that stays open). */
    holdBind?: Promise<void>;

    calls: PortalCall[] = [];
    binds: Array<Array<{id: string; description?: string; preferred_trigger?: string}>> = [];
    sessions: string[] = [];
    closedSessions: string[] = [];
    closed = false;
    connectionClosed = false;

    private handlers = new Map<string, Set<Handler>>();
    private closeHandlers: Array<(err?: Error) => void> = [];
    private sessionCounter = 0;

    readonly bus: PortalBus = {
        uniqueName: async () => this.uniqueName,
        call: (c) => this.handleCall(c),
        subscribe: async (m, handler) => {
            const key = this.key(m);
            const set = this.handlers.get(key) ?? new Set<Handler>();
            set.add(handler);
            this.handlers.set(key, set);
            return () => {
                set.delete(handler);
            };
        },
        onClose: (h) => {
            this.closeHandlers.push(h);
        },
        close: async () => {
            this.closed = true;
            this.loseConnection();
        },
    };

    /** Delivers a D-Bus signal to subscribers. */
    emit = (path: string, iface: string, member: string, args: unknown[]) => {
        this.handlers.get(this.key({path, iface, member}))?.forEach((h) => h(args));
    };

    activate = (id: string, session = this.sessions[this.sessions.length - 1]) => this.emit('/org/freedesktop/portal/desktop', 'org.freedesktop.portal.GlobalShortcuts', 'Activated', [session, id, 1n, {}]);
    deactivate = (id: string, session = this.sessions[this.sessions.length - 1]) => this.emit('/org/freedesktop/portal/desktop', 'org.freedesktop.portal.GlobalShortcuts', 'Deactivated', [session, id, 2n, {}]);
    shortcutsChanged = (list: FakeBoundShortcut[], session = this.sessions[this.sessions.length - 1]) => this.emit('/org/freedesktop/portal/desktop', 'org.freedesktop.portal.GlobalShortcuts', 'ShortcutsChanged', [session, list]);
    closeSessionFromCompositor = (session = this.sessions[this.sessions.length - 1]) => this.emit(session, 'org.freedesktop.portal.Session', 'Closed', [{}]);

    loseConnection = (err?: Error) => {
        if (this.connectionClosed) {
            return;
        }
        this.connectionClosed = true;
        this.closeHandlers.splice(0).forEach((h) => h(err));
    };

    members = () => this.calls.map((c) => c.member);

    private key = (m: SignalMatch) => `${m.path}|${m.iface}|${m.member}`;

    private requestPath = (token: string) => `/org/freedesktop/portal/desktop/request/${this.uniqueName.slice(1).replace(/\./g, '_')}/${token}`;

    private respond = (token: string, code: number, results: Record<string, unknown>, afterMs = 0) => {
        const path = this.requestPath(token);
        const deliver = () => this.emit(path, 'org.freedesktop.portal.Request', 'Response', [code, results]);
        setTimeout(deliver, afterMs);
        return path;
    };

    private dbusError = (name: string, message: string) => Object.assign(new Error(message), {dbusName: name});

    private handleCall = async (c: PortalCall): Promise<unknown> => {
        this.calls.push(c);
        if (this.connectionClosed) {
            throw this.dbusError('org.freedesktop.DBus.Error.Disconnected', 'connection closed');
        }
        const body = c.body ?? [];
        switch (`${c.iface}.${c.member}`) {
        case 'org.freedesktop.DBus.Properties.Get':
            if (this.version === 0) {
                throw this.dbusError('org.freedesktop.DBus.Error.InvalidArgs', 'No such interface');
            }
            return this.version;
        case 'org.freedesktop.host.portal.Registry.Register':
            if (this.register === 'unsupported') {
                throw this.dbusError('org.freedesktop.DBus.Error.UnknownMethod', 'no such method');
            }
            if (this.register === 'no-app-info') {
                throw this.dbusError('org.freedesktop.portal.Error.Failed', `Could not register app ID: App info not found for '${body[0]}'`);
            }
            return undefined;
        case 'org.freedesktop.portal.GlobalShortcuts.CreateSession': {
            const opts = body[0] as {handle_token: string; session_handle_token: string};
            const session = `/org/freedesktop/portal/desktop/session/${this.uniqueName.slice(1).replace(/\./g, '_')}/${opts.session_handle_token}-${++this.sessionCounter}`;
            this.sessions.push(session);
            return this.respond(opts.handle_token, 0, {session_handle: session});
        }
        case 'org.freedesktop.portal.GlobalShortcuts.BindShortcuts': {
            const list = (body[1] as Array<[string, {description?: string; preferred_trigger?: string}]>).map(([id, props]) => ({id, ...props}));
            this.binds.push(list);
            const opts = body[3] as {handle_token: string};
            const path = this.requestPath(opts.handle_token);
            const answer = () => {
                if (this.dialog === 'dismiss') {
                    this.emit(path, 'org.freedesktop.portal.Request', 'Response', [1, {}]);
                    return;
                }
                const shortcuts: FakeBoundShortcut[] = this.dialog === 'bind-nothing' ? [] : list.map((s) => [s.id, {description: s.description, trigger_description: this.triggerFor(s.id, s.preferred_trigger)}]);
                this.emit(path, 'org.freedesktop.portal.Request', 'Response', [0, {shortcuts}]);
            };
            const hold = this.holdBind;
            setTimeout(() => {
                if (hold) {
                    hold.then(answer);
                } else {
                    answer();
                }
            }, 0);
            return path;
        }
        case 'org.freedesktop.portal.Session.Close':
            this.closedSessions.push(c.path);
            return undefined;
        case 'org.freedesktop.portal.GlobalShortcuts.ConfigureShortcuts':
        case 'org.freedesktop.portal.Request.Close':
            return undefined;
        default:
            throw this.dbusError('org.freedesktop.DBus.Error.UnknownMethod', `unexpected call ${c.iface}.${c.member}`);
        }
    };
}
