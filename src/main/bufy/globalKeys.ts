// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: global push-to-talk and key capture on top of a native input hook (uiohook-napi).
//
// Privacy notes:
// - the native hook is only running while at least one push-to-talk binding or one key capture exists;
// - events are matched in this process; only "down"/"up" of the bound key (or the single captured key)
//   ever leave this module, never a stream of keystrokes;
// - bindings belong to one owner (webContents id) and are dropped when the owner goes away.

import {Logger} from 'common/log';

import {
    keyNameFromKeycode,
    modifierOfKey,
    modifiersFromEvent,
    mouseNameFromButton,
    normalizeModifiers,
    parseKeyName,
} from './keys';
import type {ParsedKey} from './keys';
import {LIMITS} from './shared';
import type {BufyResult, CapturedKey, ModifierName} from './shared';

const log = new Logger('Bufy.GlobalKeys');

export type HookEvent = {keycode?: number; button?: unknown; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean};
export type HookLike = {
    on: (event: string, listener: (e: HookEvent) => void) => unknown;
    start: () => void;
    stop: () => void;
};

export type GlobalKeysDeps = {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    loadHook: () => Promise<HookLike>;
    isAccessibilityTrusted: () => boolean;
};

export type GlobalKeysStatus = {
    available: boolean;
    reason?: string;
    permission: 'granted' | 'denied' | 'not-required';
};

type PttBinding = {
    ownerId: number;
    key: ParsedKey;
    modifiers: ModifierName[];
    isDown: boolean;
    onDown: () => void;
    onUp: () => void;
};

type Capture = {
    ownerId: number;
    pendingModifier?: string;
    resolve: (r: BufyResult<{captured: CapturedKey}>) => void;
    timer: NodeJS.Timeout;
};

export class GlobalKeys {
    private bindings = new Map<number, PttBinding>();
    private capture?: Capture;
    private hook?: HookLike;
    private hookError?: unknown;
    private listening = false;
    private running = false;

    private deps: GlobalKeysDeps;

    constructor(deps: GlobalKeysDeps) {
        this.deps = deps;
    }

    getStatus = async (): Promise<GlobalKeysStatus> => {
        const {platform, env} = this.deps;
        let permission: GlobalKeysStatus['permission'] = 'not-required';
        if (platform === 'darwin') {
            permission = this.deps.isAccessibilityTrusted() ? 'granted' : 'denied';
        }

        if (platform === 'linux') {
            if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) {
                return {available: false, reason: 'wayland', permission};
            }
            if (!env.DISPLAY) {
                return {available: false, reason: 'no-display', permission};
            }
        }
        if (permission === 'denied') {
            return {available: false, reason: 'permission-denied', permission};
        }

        try {
            await this.getHook();
        } catch (err) {
            log.warn('native input hook unavailable', {err});
            return {available: false, reason: 'native-module-failed', permission};
        }
        return {available: true, permission};
    };

    registerPtt = async (ownerId: number, keyName: string, modifiers: ModifierName[] | undefined, onDown: () => void, onUp: () => void): Promise<BufyResult> => {
        const parsed = parseKeyName(keyName);
        if (!parsed) {
            return {ok: false, error: 'invalid-argument', message: `Unsupported key "${keyName}"`};
        }
        const status = await this.getStatus();
        if (!status.available) {
            return {ok: false, error: status.reason === 'permission-denied' ? 'permission-denied' : 'unsupported', message: status.reason};
        }

        // Replacing an existing binding of the same owner is allowed (re-binding in settings).
        this.releaseBinding(ownerId);

        this.bindings.set(ownerId, {
            ownerId,
            key: parsed,
            modifiers: parsed.type === 'keyboard' && modifierOfKey(parsed.name) ? [] : normalizeModifiers(modifiers),
            isDown: false,
            onDown,
            onUp,
        });
        const started = this.ensureRunning();
        if (!started.ok) {
            this.bindings.delete(ownerId);
            return started;
        }
        return {ok: true};
    };

    unregisterPtt = (ownerId: number): BufyResult => {
        this.releaseBinding(ownerId);
        this.maybeStop();
        return {ok: true};
    };

    hasPtt = (ownerId: number) => this.bindings.has(ownerId);

    captureNextKey = async (ownerId: number, timeoutMs = LIMITS.captureDefaultTimeoutMs): Promise<BufyResult<{captured: CapturedKey}>> => {
        const status = await this.getStatus();
        if (!status.available) {
            return {ok: false, error: status.reason === 'permission-denied' ? 'permission-denied' : 'unsupported', message: status.reason};
        }
        if (this.capture) {
            return {ok: false, error: 'in-use', message: 'Another capture is already running'};
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => this.finishCapture({ok: false, error: 'timeout'}), timeoutMs);
            this.capture = {ownerId, resolve, timer};
            const started = this.ensureRunning();
            if (!started.ok) {
                this.finishCapture(started);
            }
        });
    };

    cancelCapture = (ownerId: number): BufyResult => {
        if (this.capture && this.capture.ownerId === ownerId) {
            this.finishCapture({ok: false, error: 'cancelled'});
        }
        return {ok: true};
    };

    /** Drops everything that belongs to a webContents (destroyed, navigated, view removed). */
    releaseOwner = (ownerId: number) => {
        this.releaseBinding(ownerId);
        if (this.capture?.ownerId === ownerId) {
            this.finishCapture({ok: false, error: 'cancelled'});
        }
        this.maybeStop();
    };

    dispose = () => {
        for (const id of [...this.bindings.keys()]) {
            this.releaseBinding(id);
        }
        if (this.capture) {
            this.finishCapture({ok: false, error: 'cancelled'});
        }
        this.maybeStop();
    };

    // ---- internals ----

    private releaseBinding = (ownerId: number) => {
        const b = this.bindings.get(ownerId);
        if (!b) {
            return;
        }
        this.bindings.delete(ownerId);
        if (b.isDown) {
            // never leave the other side with an open mic
            try {
                b.onUp();
            } catch (err) {
                log.warn('ptt release callback failed', {err});
            }
        }
    };

    private finishCapture = (result: BufyResult<{captured: CapturedKey}>) => {
        const c = this.capture;
        if (!c) {
            return;
        }
        this.capture = undefined;
        clearTimeout(c.timer);
        c.resolve(result);
        this.maybeStop();
    };

    private getHook = async (): Promise<HookLike> => {
        if (this.hookError) {
            throw this.hookError;
        }
        if (!this.hook) {
            try {
                this.hook = await this.deps.loadHook();
            } catch (err) {
                this.hookError = err;
                throw err;
            }
        }
        return this.hook;
    };

    // Only called after getStatus() resolved, i.e. the hook is loaded.
    private ensureRunning = (): BufyResult => {
        try {
            const hook = this.hook;
            if (!hook) {
                throw new Error('hook not loaded');
            }
            if (!this.listening) {
                hook.on('keydown', this.onKeyDown);
                hook.on('keyup', this.onKeyUp);
                hook.on('mousedown', this.onMouseDown);
                hook.on('mouseup', this.onMouseUp);
                this.listening = true;
            }
            if (!this.running) {
                hook.start();
                this.running = true;
            }
            return {ok: true};
        } catch (err) {
            log.error('failed to start native input hook', {err});
            return {ok: false, error: 'registration-failed', message: 'Could not start the global input hook'};
        }
    };

    private maybeStop = () => {
        if (this.running && this.bindings.size === 0 && !this.capture) {
            try {
                this.hook?.stop();
            } catch (err) {
                log.warn('failed to stop native input hook', {err});
            }
            this.running = false;
        }
    };

    private onKeyDown = (e: HookEvent) => {
        const name = e.keycode === undefined ? undefined : keyNameFromKeycode(e.keycode);
        if (!name) {
            return;
        }

        const cap = this.capture;
        if (cap) {
            if (modifierOfKey(name)) {
                // A lone modifier is only captured on release, so chords like Ctrl+Space can still be entered.
                cap.pendingModifier ??= name;
            } else {
                this.finishCapture({ok: true, captured: {key: name, modifiers: modifiersFromEvent(e), type: 'keyboard'}});
            }
        }

        this.bindings.forEach((b) => {
            if (b.key.type === 'keyboard' && b.key.keycode === e.keycode && !b.isDown && this.modifiersMatch(b, e)) {
                this.fire(b, true);
            }
        });
    };

    private onKeyUp = (e: HookEvent) => {
        const name = e.keycode === undefined ? undefined : keyNameFromKeycode(e.keycode);
        if (!name) {
            return;
        }

        if (this.capture?.pendingModifier === name) {
            this.finishCapture({ok: true, captured: {key: name, modifiers: [], type: 'keyboard'}});
        }

        this.bindings.forEach((b) => {
            if (b.key.type === 'keyboard' && b.key.keycode === e.keycode && b.isDown) {
                this.fire(b, false);
            }
        });
    };

    private onMouseDown = (e: HookEvent) => {
        const name = mouseNameFromButton(e.button);
        if (!name) {
            // left/right/unknown buttons are never bindable (and the click on the "set key" button must not be captured)
            return;
        }
        if (this.capture) {
            this.finishCapture({ok: true, captured: {key: name, modifiers: modifiersFromEvent(e), type: 'mouse'}});
        }
        this.bindings.forEach((b) => {
            if (b.key.type === 'mouse' && b.key.name === name && !b.isDown && this.modifiersMatch(b, e)) {
                this.fire(b, true);
            }
        });
    };

    private onMouseUp = (e: HookEvent) => {
        const name = mouseNameFromButton(e.button);
        if (!name) {
            return;
        }
        this.bindings.forEach((b) => {
            if (b.key.type === 'mouse' && b.key.name === name && b.isDown) {
                this.fire(b, false);
            }
        });
    };

    private modifiersMatch = (b: PttBinding, e: HookEvent) => {
        if (!b.modifiers.length) {
            return true;
        }
        const held = new Set(modifiersFromEvent(e));
        return b.modifiers.every((m) => held.has(m));
    };

    private fire = (b: PttBinding, down: boolean) => {
        b.isDown = down;
        try {
            (down ? b.onDown : b.onUp)();
        } catch (err) {
            log.warn('ptt callback failed', {err});
        }
    };
}
