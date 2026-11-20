// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: picks the mechanism behind push-to-talk and global shortcuts.
//
//   Windows / macOS / Linux X11 -> `uiohook`  native input hook (push-to-talk, key capture) + Electron globalShortcut (toggles)
//   Linux Wayland               -> `portal`   xdg-desktop-portal GlobalShortcuts (both push-to-talk and toggles)
//   anything else               -> unsupported, with a precise reason
//
// On Wayland Electron's own `globalShortcut` is never used: all shortcuts go through our single portal session, so
// the app never has two competing portal sessions/dialogs (Chromium's built-in GlobalShortcutsPortal feature is not
// enabled by this fork and must stay that way).

import type {GlobalKeys, GlobalKeysStatus} from './globalKeys';
import type {PortalKeys} from './portalKeys';
import type {BindingInfo, BufyResult, CapturedKey, GlobalKeysBackend, ModifierName} from './shared';
import type {ShortcutRegistry} from './shortcuts';

export type KeysStatus = GlobalKeysStatus & {backend: GlobalKeysBackend | null};

export type KeysBackendDeps = {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    uiohook: GlobalKeys;
    portal: PortalKeys;
    shortcuts: ShortcutRegistry;
};

export class KeysBackend {
    private deps: KeysBackendDeps;

    constructor(deps: KeysBackendDeps) {
        this.deps = deps;
    }

    get isWayland() {
        const {platform, env} = this.deps;
        return platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY));
    }

    getStatus = async (): Promise<KeysStatus> => {
        if (this.isWayland) {
            const p = await this.deps.portal.getStatus();
            return p.available ? {available: true, permission: 'not-required', backend: 'portal'} : {available: false, reason: p.reason, permission: 'not-required', backend: null};
        }
        const s = await this.deps.uiohook.getStatus();
        return {...s, backend: s.available ? 'uiohook' : null};
    };

    /** Push-to-talk / shortcuts via the portal need no hook but the compositor decides the key. */
    get keyCaptureSupported() {
        return !this.isWayland;
    }

    registerPtt = async (ownerId: number, key: string, modifiers: ModifierName[] | undefined, onDown: () => void, onUp: () => void): Promise<BufyResult<BindingInfo>> => {
        if (this.isWayland) {
            const status = await this.deps.portal.getStatus();
            if (!status.available) {
                return {ok: false, error: 'unsupported', message: status.reason};
            }
            return this.deps.portal.registerPtt(ownerId, key, modifiers, onDown, onUp);
        }
        const res = await this.deps.uiohook.registerPtt(ownerId, key, modifiers, onDown, onUp);
        return res.ok ? {ok: true, backend: 'uiohook'} : res;
    };

    unregisterPtt = (ownerId: number): BufyResult => {
        this.deps.uiohook.unregisterPtt(ownerId);
        return this.deps.portal.unregisterPtt(ownerId);
    };

    captureNextKey = (ownerId: number, timeoutMs?: number): Promise<BufyResult<{captured: CapturedKey}>> => {
        if (this.isWayland) {
            return Promise.resolve({
                ok: false,
                error: 'unsupported-on-wayland',
                message: 'Wayland does not let apps read keys globally. Call registerPushToTalk and let the system dialog assign the key.',
            });
        }
        return this.deps.uiohook.captureNextKey(ownerId, timeoutMs);
    };

    cancelCapture = (ownerId: number): BufyResult => this.deps.uiohook.cancelCapture(ownerId);

    registerShortcut = async (ownerId: number, id: string, accelerator: string, onActivated: () => void): Promise<BufyResult<BindingInfo>> => {
        if (this.isWayland) {
            const status = await this.deps.portal.getStatus();
            if (!status.available) {
                return {ok: false, error: 'unsupported', message: status.reason};
            }
            return this.deps.portal.registerShortcut(ownerId, id, accelerator, onActivated);
        }
        const res = this.deps.shortcuts.register(ownerId, id, accelerator);
        return res.ok ? {ok: true, backend: 'electron'} : res;
    };

    unregisterShortcut = (ownerId: number, id: string): BufyResult => {
        this.deps.shortcuts.unregister(ownerId, id);
        return this.deps.portal.unregisterShortcut(ownerId, id);
    };

    /** Portal backend only: opens the compositor's shortcut settings. */
    openShortcutSettings = async (): Promise<BufyResult> => {
        if (!this.isWayland) {
            return {ok: false, error: 'unsupported', message: 'Only the portal backend has system shortcut settings'};
        }
        return this.deps.portal.configureShortcuts();
    };

    releaseOwner = (ownerId: number) => {
        this.deps.uiohook.releaseOwner(ownerId);
        this.deps.shortcuts.releaseOwner(ownerId);
        this.deps.portal.releaseOwner(ownerId);
    };

    dispose = () => {
        this.deps.uiohook.dispose();
        this.deps.shortcuts.dispose();
        this.deps.portal.dispose();
    };
}
