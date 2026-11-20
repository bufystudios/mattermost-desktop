// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {GlobalKeys} from './globalKeys';
import type {GlobalKeysDeps, HookEvent, HookLike} from './globalKeys';

const KEY = {Space: 57, F9: 67, ControlLeft: 29, ControlRight: 3613, KeyV: 47};

function makeHook() {
    const listeners: Record<string, Array<(e: HookEvent) => void>> = {};
    const hook = {
        on: jest.fn((event: string, cb: (e: HookEvent) => void) => {
            (listeners[event] ??= []).push(cb);
        }),
        start: jest.fn(),
        stop: jest.fn(),
    };
    const emit = (event: string, e: Partial<HookEvent>) => {
        listeners[event]?.forEach((cb) => cb({ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...e}));
    };
    return {hook: hook as HookLike & typeof hook, emit};
}

// let the async capability check inside captureNextKey() settle so the capture is armed
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function make(overrides: Partial<GlobalKeysDeps> = {}) {
    const {hook, emit} = makeHook();
    const deps: GlobalKeysDeps = {
        platform: 'linux',
        env: {DISPLAY: ':0'},
        loadHook: jest.fn().mockResolvedValue(hook),
        isAccessibilityTrusted: jest.fn().mockReturnValue(true),
        ...overrides,
    };
    return {keys: new GlobalKeys(deps), hook, emit, deps};
}

describe('bufy/GlobalKeys', () => {
    describe('capability / permission gating', () => {
        it('is available on X11', async () => {
            const {keys} = make();
            expect(await keys.getStatus()).toEqual({available: true, permission: 'not-required'});
        });

        it.each([
            ['XDG_SESSION_TYPE', {XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0'}],
            ['WAYLAND_DISPLAY', {WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0'}],
        ])('reports wayland unavailable (%s)', async (_n, env) => {
            const {keys, deps} = make({env});
            expect(await keys.getStatus()).toEqual({available: false, reason: 'wayland', permission: 'not-required'});
            expect(deps.loadHook).not.toHaveBeenCalled();
        });

        it('reports no-display on linux without DISPLAY', async () => {
            const {keys} = make({env: {}});
            expect(await keys.getStatus()).toMatchObject({available: false, reason: 'no-display'});
        });

        it('requires Accessibility permission on macOS and never loads the hook without it', async () => {
            const {keys, deps} = make({platform: 'darwin', env: {}, isAccessibilityTrusted: jest.fn().mockReturnValue(false)});
            expect(await keys.getStatus()).toEqual({available: false, reason: 'permission-denied', permission: 'denied'});
            const res = await keys.registerPtt(1, 'Space', [], jest.fn(), jest.fn());
            expect(res).toMatchObject({ok: false, error: 'permission-denied'});
            expect(deps.loadHook).not.toHaveBeenCalled();
        });

        it('works on macOS when granted', async () => {
            const {keys} = make({platform: 'darwin', env: {}});
            expect(await keys.getStatus()).toEqual({available: true, permission: 'granted'});
        });

        it('degrades gracefully when the native module cannot be loaded', async () => {
            const {keys} = make({loadHook: jest.fn().mockRejectedValue(new Error('libXt.so.6: cannot open shared object file'))});
            expect(await keys.getStatus()).toMatchObject({available: false, reason: 'native-module-failed'});
            expect(await keys.registerPtt(1, 'Space', [], jest.fn(), jest.fn())).toMatchObject({ok: false, error: 'unsupported'});
        });

        it('on windows needs no permission', async () => {
            const {keys} = make({platform: 'win32', env: {}});
            expect(await keys.getStatus()).toEqual({available: true, permission: 'not-required'});
        });
    });

    describe('push to talk', () => {
        it('emits down once (ignoring auto-repeat) and up on release', async () => {
            const {keys, emit, hook} = make();
            const down = jest.fn();
            const up = jest.fn();
            expect(await keys.registerPtt(1, 'Space', [], down, up)).toEqual({ok: true});
            expect(hook.start).toHaveBeenCalledTimes(1);

            emit('keydown', {keycode: KEY.Space});
            emit('keydown', {keycode: KEY.Space});
            emit('keydown', {keycode: KEY.Space});
            expect(down).toHaveBeenCalledTimes(1);
            emit('keyup', {keycode: KEY.Space});
            expect(up).toHaveBeenCalledTimes(1);
            emit('keyup', {keycode: KEY.Space});
            expect(up).toHaveBeenCalledTimes(1);
        });

        it('ignores other keys', async () => {
            const {keys, emit} = make();
            const down = jest.fn();
            await keys.registerPtt(1, 'Space', [], down, jest.fn());
            emit('keydown', {keycode: KEY.F9});
            emit('mousedown', {button: 4});
            expect(down).not.toHaveBeenCalled();
        });

        it('supports mouse buttons (Mouse4/Mouse5/middle) and ignores left/right', async () => {
            const {keys, emit} = make();
            const down = jest.fn();
            const up = jest.fn();
            await keys.registerPtt(1, 'Mouse4', [], down, up);
            emit('mousedown', {button: 1});
            emit('mousedown', {button: 2});
            emit('mousedown', {button: 5});
            expect(down).not.toHaveBeenCalled();
            emit('mousedown', {button: 4});
            expect(down).toHaveBeenCalledTimes(1);
            emit('mouseup', {button: 4});
            expect(up).toHaveBeenCalledTimes(1);

            await keys.registerPtt(2, 'MouseMiddle', [], down, up);
            emit('mousedown', {button: 3});
            expect(down).toHaveBeenCalledTimes(2);
        });

        it('requires configured modifiers on key down but releases on key up regardless', async () => {
            const {keys, emit} = make();
            const down = jest.fn();
            const up = jest.fn();
            await keys.registerPtt(1, 'KeyV', ['ctrl'], down, up);
            emit('keydown', {keycode: KEY.KeyV});
            expect(down).not.toHaveBeenCalled();
            emit('keydown', {keycode: KEY.KeyV, ctrlKey: true});
            expect(down).toHaveBeenCalledTimes(1);
            emit('keyup', {keycode: KEY.KeyV}); // ctrl already released
            expect(up).toHaveBeenCalledTimes(1);
        });

        it('lets a modifier key itself be the PTT key', async () => {
            const {keys, emit} = make();
            const down = jest.fn();
            await keys.registerPtt(1, 'ControlRight', ['shift'], down, jest.fn());
            emit('keydown', {keycode: KEY.ControlRight});
            expect(down).toHaveBeenCalledTimes(1);
        });

        it('rejects unknown keys', async () => {
            const {keys} = make();
            expect(await keys.registerPtt(1, 'Mouse1', [], jest.fn(), jest.fn())).toMatchObject({ok: false, error: 'invalid-argument'});
        });

        it('re-registering replaces the binding of the same owner and sends up if the old key was down', async () => {
            const {keys, emit} = make();
            const down = jest.fn();
            const up = jest.fn();
            await keys.registerPtt(1, 'Space', [], down, up);
            emit('keydown', {keycode: KEY.Space});
            await keys.registerPtt(1, 'F9', [], down, up);
            expect(up).toHaveBeenCalledTimes(1);
            emit('keydown', {keycode: KEY.Space});
            expect(down).toHaveBeenCalledTimes(1);
            emit('keydown', {keycode: KEY.F9});
            expect(down).toHaveBeenCalledTimes(2);
        });

        it('keeps bindings of different owners separate', async () => {
            const {keys, emit} = make();
            const a = {down: jest.fn(), up: jest.fn()};
            const b = {down: jest.fn(), up: jest.fn()};
            await keys.registerPtt(1, 'Space', [], a.down, a.up);
            await keys.registerPtt(2, 'F9', [], b.down, b.up);
            emit('keydown', {keycode: KEY.F9});
            expect(a.down).not.toHaveBeenCalled();
            expect(b.down).toHaveBeenCalledTimes(1);
        });

        it('stops the hook when the last binding is gone and releases a held key', async () => {
            const {keys, emit, hook} = make();
            const up = jest.fn();
            await keys.registerPtt(1, 'Space', [], jest.fn(), up);
            emit('keydown', {keycode: KEY.Space});
            keys.releaseOwner(1);
            expect(up).toHaveBeenCalledTimes(1);
            expect(hook.stop).toHaveBeenCalledTimes(1);
            expect(keys.hasPtt(1)).toBe(false);
        });

        it('restarts the hook after it was stopped, without double-subscribing', async () => {
            const {keys, emit, hook} = make();
            const down = jest.fn();
            await keys.registerPtt(1, 'Space', [], down, jest.fn());
            keys.unregisterPtt(1);
            await keys.registerPtt(1, 'Space', [], down, jest.fn());
            expect(hook.start).toHaveBeenCalledTimes(2);
            expect(hook.on).toHaveBeenCalledTimes(4);
            emit('keydown', {keycode: KEY.Space});
            expect(down).toHaveBeenCalledTimes(1);
        });

        it('reports registration-failed when the hook cannot start', async () => {
            const {keys, hook} = make();
            hook.start.mockImplementation(() => {
                throw new Error('boom');
            });
            expect(await keys.registerPtt(1, 'Space', [], jest.fn(), jest.fn())).toMatchObject({ok: false, error: 'registration-failed'});
            expect(keys.hasPtt(1)).toBe(false);
        });

        it('dispose releases everything', async () => {
            const {keys, hook} = make();
            await keys.registerPtt(1, 'Space', [], jest.fn(), jest.fn());
            keys.dispose();
            expect(hook.stop).toHaveBeenCalled();
            expect(keys.hasPtt(1)).toBe(false);
        });
    });

    describe('captureNextKey', () => {
        it('resolves with the next non-modifier key and the held modifiers', async () => {
            const {keys, emit} = make();
            const p = keys.captureNextKey(1, 5000);
            await flush();
            emit('keydown', {keycode: KEY.ControlLeft, ctrlKey: true});
            emit('keydown', {keycode: KEY.Space, ctrlKey: true});
            expect(await p).toEqual({ok: true, captured: {key: 'Space', modifiers: ['ctrl'], type: 'keyboard'}});
        });

        it('resolves a lone modifier on release', async () => {
            const {keys, emit} = make();
            const p = keys.captureNextKey(1, 5000);
            await flush();
            emit('keydown', {keycode: KEY.ControlRight, ctrlKey: true});
            emit('keyup', {keycode: KEY.ControlRight});
            expect(await p).toEqual({ok: true, captured: {key: 'ControlRight', modifiers: [], type: 'keyboard'}});
        });

        it('captures mouse buttons but ignores left/right clicks', async () => {
            const {keys, emit} = make();
            const p = keys.captureNextKey(1, 5000);
            await flush();
            emit('mousedown', {button: 1});
            emit('mousedown', {button: 2});
            emit('mousedown', {button: 5});
            expect(await p).toEqual({ok: true, captured: {key: 'Mouse5', modifiers: [], type: 'mouse'}});
        });

        it('times out and stops the hook', async () => {
            jest.useFakeTimers();
            try {
                const {keys, hook} = make();
                const p = keys.captureNextKey(1, 1000);
                for (let i = 0; i < 10; i++) {
                    // eslint-disable-next-line no-await-in-loop
                    await Promise.resolve(); // let the async capability check arm the timer
                }
                jest.advanceTimersByTime(1001);
                expect(await p).toMatchObject({ok: false, error: 'timeout'});
                expect(hook.stop).toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        it('allows only one capture at a time', async () => {
            const {keys} = make();
            const first = keys.captureNextKey(1, 5000);
            await flush();
            expect(await keys.captureNextKey(2, 5000)).toMatchObject({ok: false, error: 'in-use'});
            keys.cancelCapture(1);
            expect(await first).toMatchObject({ok: false, error: 'cancelled'});
        });

        it('cancelCapture of another owner does nothing; releaseOwner cancels', async () => {
            const {keys} = make();
            const p = keys.captureNextKey(1, 5000);
            await flush();
            keys.cancelCapture(2);
            keys.releaseOwner(1);
            expect(await p).toMatchObject({ok: false, error: 'cancelled'});
        });

        it('is refused when global keys are unavailable', async () => {
            const {keys} = make({env: {WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0'}});
            expect(await keys.captureNextKey(1, 1000)).toMatchObject({ok: false, error: 'unsupported'});
        });

        it('keeps push-to-talk working for its owner while a capture runs', async () => {
            const {keys, emit} = make();
            const down = jest.fn();
            await keys.registerPtt(2, 'F9', [], down, jest.fn());
            const p = keys.captureNextKey(1, 5000);
            await flush();
            emit('keydown', {keycode: KEY.F9});
            await p;

            // PTT still works for its owner while a capture is running (the capture only observes)
            expect(down).toHaveBeenCalledTimes(1);
        });
    });
});
