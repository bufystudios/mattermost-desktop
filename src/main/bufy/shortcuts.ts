// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: per-view global shortcuts (mute/deafen/go-live toggles) on top of Electron's globalShortcut.

import {Logger} from 'common/log';

import {LIMITS} from './shared';
import type {BufyResult} from './shared';
import {acceleratorIdentity, checkAccelerator} from './validation';

const log = new Logger('Bufy.Shortcuts');

export type ShortcutBackend = {
    register: (accelerator: string, callback: () => void) => boolean;
    unregister: (accelerator: string) => void;
    isRegistered: (accelerator: string) => boolean;
};

type Entry = {ownerId: number; id: string; accelerator: string};

export class ShortcutRegistry {
    private byIdentity = new Map<string, Entry>();
    private byOwner = new Map<number, Map<string, Entry>>();

    private backend: ShortcutBackend;
    private emit: (ownerId: number, id: string) => void;

    constructor(backend: ShortcutBackend, emit: (ownerId: number, id: string) => void) {
        this.backend = backend;
        this.emit = emit;
    }

    register = (ownerId: number, id: string, accelerator: string): BufyResult => {
        const check = checkAccelerator(accelerator);
        if (!check.ok) {
            return {ok: false, error: 'invalid-argument', message: check.message};
        }

        const owned = this.byOwner.get(ownerId) ?? new Map<string, Entry>();
        const existing = owned.get(id);
        if (!existing && owned.size >= LIMITS.maxShortcutsPerView) {
            return {ok: false, error: 'limit-reached', message: `At most ${LIMITS.maxShortcutsPerView} shortcuts per view`};
        }

        const identity = acceleratorIdentity(accelerator);
        const holder = this.byIdentity.get(identity);
        if (holder && !(holder.ownerId === ownerId && holder.id === id)) {
            return {ok: false, error: 'in-use', message: 'Accelerator already registered'};
        }

        // Re-registering an id moves it to the new accelerator.
        if (existing) {
            this.remove(existing);
        }

        // Never steal an accelerator another part of the app (or another app) already holds.
        if (this.backend.isRegistered(accelerator)) {
            if (existing) {
                // we just removed the old one; nothing to restore, the plugin gets an error and can retry
                owned.delete(id);
            }
            return {ok: false, error: 'in-use', message: 'Accelerator already registered'};
        }

        let registered = false;
        try {
            registered = this.backend.register(accelerator, () => this.emit(ownerId, id));
        } catch (err) {
            log.warn('globalShortcut.register threw', {err});
        }
        if (!registered) {
            return {ok: false, error: 'registration-failed', message: 'The OS refused the shortcut (taken by another app or unsupported here)'};
        }

        const entry: Entry = {ownerId, id, accelerator};
        owned.set(id, entry);
        this.byOwner.set(ownerId, owned);
        this.byIdentity.set(identity, entry);
        return {ok: true};
    };

    unregister = (ownerId: number, id: string): BufyResult => {
        const entry = this.byOwner.get(ownerId)?.get(id);
        if (entry) {
            this.remove(entry);
        }
        return {ok: true};
    };

    releaseOwner = (ownerId: number) => {
        const owned = this.byOwner.get(ownerId);
        if (!owned) {
            return;
        }
        for (const entry of [...owned.values()]) {
            this.remove(entry);
        }
    };

    dispose = () => {
        for (const ownerId of [...this.byOwner.keys()]) {
            this.releaseOwner(ownerId);
        }
    };

    count = (ownerId: number) => this.byOwner.get(ownerId)?.size ?? 0;

    private remove = (entry: Entry) => {
        try {
            this.backend.unregister(entry.accelerator);
        } catch (err) {
            log.warn('globalShortcut.unregister threw', {err});
        }
        this.byIdentity.delete(acceleratorIdentity(entry.accelerator));
        const owned = this.byOwner.get(entry.ownerId);
        owned?.delete(entry.id);
        if (owned && owned.size === 0) {
            this.byOwner.delete(entry.ownerId);
        }
    };
}
