// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {EventEmitter} from 'events';

import {BufyManager} from './manager';
import {BUFY_API_VERSION, BUFY_CHANNELS as CH} from './shared';
import {FakePortal} from './testing/fakePortalBus';
import {getTrayVoiceStatus} from './trayStatus';

type AnyFn = (...args: unknown[]) => unknown;
type VoidFn = () => void;

const mockHandlers = new Map<string, AnyFn>();
const mockWebContentsById = new Map<number, ReturnType<typeof makeWebContents>>();
const mockAppEmitter = new EventEmitter();
const mockShortcuts = new Map<string, VoidFn>();
const mockHookListeners: Record<string, Array<(e: unknown) => void>> = {};
const mockHook = {
    on: jest.fn((ev: string, cb: (e: unknown) => void) => {
        (mockHookListeners[ev] ??= []).push(cb);
    }),
    start: jest.fn(),
    stop: jest.fn(),
};
const emitHook = (ev: string, e: Record<string, unknown>) => mockHookListeners[ev]?.forEach((cb) => cb({ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...e}));

const mockTray = {refresh: jest.fn(), isAvailable: jest.fn().mockReturnValue(true), setMenu: jest.fn()};
const mockViewManager = new EventEmitter();
const mockResolve = jest.fn();
const mockSystemPrefs = {isTrustedAccessibilityClient: jest.fn().mockReturnValue(true)};
const mockOverlayShow = jest.fn();
const mockConnectBus = jest.fn();
const mockSetDisplayMedia = jest.fn();

jest.mock('electron', () => ({
    app: {on: (ev: string, cb: () => void) => mockAppEmitter.on(ev, cb)},
    desktopCapturer: {getSources: jest.fn().mockResolvedValue([{id: 'screen:1:0', display_id: '60'}])},
    globalShortcut: {
        register: jest.fn((a: string, cb: () => void) => {
            mockShortcuts.set(a.toLowerCase(), cb);
            return true;
        }),
        unregister: jest.fn((a: string) => mockShortcuts.delete(a.toLowerCase())),
        isRegistered: jest.fn((a: string) => mockShortcuts.has(a.toLowerCase())),
    },
    ipcMain: {handle: (ch: string, fn: (...args: unknown[]) => unknown) => mockHandlers.set(ch, fn)},
    screen: {getAllDisplays: () => [{id: 60, bounds: {x: 0, y: 0, width: 1920, height: 1080}}], getPrimaryDisplay: () => ({id: 60, bounds: {x: 0, y: 0, width: 1920, height: 1080}}), screenToDipRect: (_: unknown, r: unknown) => r},
    session: {defaultSession: {setDisplayMediaRequestHandler: (...a: unknown[]) => mockSetDisplayMedia(...a)}},
    shell: {openExternal: jest.fn().mockResolvedValue(undefined)},
    systemPreferences: {isTrustedAccessibilityClient: (...a: unknown[]) => mockSystemPrefs.isTrustedAccessibilityClient(...a)},
    webContents: {fromId: (id: number) => mockWebContentsById.get(id), fromFrame: jest.fn()},
    nativeImage: {},
    BrowserWindow: jest.fn(),
}));
jest.mock('app/system/tray/tray', () => ({
    __esModule: true,
    default: {
        refresh: (...a: unknown[]) => mockTray.refresh(...a),
        isAvailable: () => mockTray.isAvailable(),
        setMenu: (...a: unknown[]) => mockTray.setMenu(...a),
    },
}));
jest.mock('main/security/permissionsManager', () => ({__esModule: true, default: {doPermissionRequest: jest.fn().mockResolvedValue(true)}}));
jest.mock('app/menus/tray', () => ({__esModule: true, default: jest.fn(() => 'menu')}));
jest.mock('common/views/viewManager', () => ({__esModule: true, default: {on: (...a: [string, () => void]) => mockViewManager.on(...a)}}));
jest.mock('./security', () => ({resolveTrustedSender: (...a: unknown[]) => mockResolve(...a)}));
jest.mock('./overlayWindow', () => ({
    createOverlayWindow: jest.fn((b: unknown) => {
        mockOverlayShow(b);
        return {setBounds: jest.fn(), showInactive: jest.fn(), hide: jest.fn(), destroy: jest.fn(), isDestroyed: () => false, isVisible: () => true};
    }),
}));
jest.mock('./portalBus', () => ({connectSessionBus: (...a: unknown[]) => mockConnectBus(...a)}));
jest.mock('./windowBounds', () => ({createWindowBoundsProvider: () => undefined}));
jest.mock('uiohook-napi', () => ({
    uIOhook: {
        on: (...a: [string, () => void]) => mockHook.on(...a),
        start: () => mockHook.start(),
        stop: () => mockHook.stop(),
    },
}), {virtual: true});

function makeWebContents(id: number, focused = true) {
    const ee = new EventEmitter() as EventEmitter & {id: number; send: jest.Mock; isDestroyed: () => boolean; isFocused: () => boolean};
    ee.id = id;
    ee.send = jest.fn();
    ee.isDestroyed = () => false;
    ee.isFocused = () => focused;
    mockWebContentsById.set(id, ee as never);
    return ee;
}

const trusted = (id: number, viewId = `view-${id}`) => ({webContentsId: id, viewId, serverId: 'srv', origin: 'https://chat.example.com'});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (channel: string, sender: ReturnType<typeof makeWebContents>, ...args: unknown[]) => mockHandlers.get(channel)!({sender, senderFrame: {url: 'https://chat.example.com/', parent: null}}, ...args) as Promise<any>;

describe('bufy/BufyManager', () => {
    let mgr: BufyManager;
    let wcA: ReturnType<typeof makeWebContents>;
    let wcB: ReturnType<typeof makeWebContents>;
    const platform = process.platform;

    beforeEach(() => {
        mockHandlers.clear();
        mockWebContentsById.clear();
        mockShortcuts.clear();
        Object.keys(mockHookListeners).forEach((k) => delete mockHookListeners[k]);
        mockAppEmitter.removeAllListeners();
        mockViewManager.removeAllListeners();
        mockConnectBus.mockReset();
        mockSetDisplayMedia.mockClear();
        mockOverlayShow.mockClear();
        mockConnectBus.mockRejectedValue(new Error('no session bus'));
        mockHook.on.mockClear();
        mockHook.start.mockClear();
        mockHook.stop.mockClear();
        mockTray.refresh.mockClear();
        mockTray.setMenu.mockClear();
        mockTray.isAvailable.mockReturnValue(true);
        mockSystemPrefs.isTrustedAccessibilityClient.mockReturnValue(true);
        wcA = makeWebContents(1);
        wcB = makeWebContents(2);
        mockResolve.mockImplementation((e: {sender: {id: number}}) => (e.sender.id === 99 ? undefined : trusted(e.sender.id)));
        Object.defineProperty(process, 'platform', {value: 'linux'});
        process.env.DISPLAY = ':0';
        delete process.env.WAYLAND_DISPLAY;
        process.env.XDG_SESSION_TYPE = 'x11';
        mgr = new BufyManager();
        mgr.init();
    });

    // platform is read once at init, like in the real app
    const reinit = (p: NodeJS.Platform) => {
        mgr.dispose();
        Object.defineProperty(process, 'platform', {value: p});
        mockHandlers.clear();
        mgr = new BufyManager();
        mgr.init();
    };

    afterEach(() => {
        mgr.dispose();
        Object.defineProperty(process, 'platform', {value: platform});
    });

    it('registers every channel exactly once and is idempotent', () => {
        const count = mockHandlers.size;
        expect(count).toBe(12);
        mgr.init();
        expect(mockHandlers.size).toBe(count);
    });

    describe('trust', () => {
        it.each([
            [CH.GET_CAPABILITIES, []],
            [CH.SHOW_SHARE_BORDER, [{sourceId: 'screen:1:0'}]],
            [CH.HIDE_SHARE_BORDER, []],
            [CH.REGISTER_PTT, [{key: 'Space'}]],
            [CH.UNREGISTER_PTT, []],
            [CH.REGISTER_SHORTCUT, [{id: 'a', accelerator: 'Ctrl+Alt+A'}]],
            [CH.UNREGISTER_SHORTCUT, ['a']],
            [CH.CAPTURE_NEXT_KEY, [{}]],
            [CH.CANCEL_CAPTURE, []],
            [CH.OPEN_ACCESSIBILITY_SETTINGS, []],
            [CH.OPEN_SHORTCUT_SETTINGS, []],
            [CH.SET_VOICE_STATUS, [{connected: true}]],
        ])('%s rejects untrusted senders and has no side effects', async (channel, args) => {
            const untrusted = makeWebContents(99);
            expect(await call(channel, untrusted, ...args)).toEqual({ok: false, error: 'untrusted-sender'});
            expect(mockHook.start).not.toHaveBeenCalled();
            expect(mockShortcuts.size).toBe(0);
            expect(mockTray.refresh).not.toHaveBeenCalled();
            expect(getTrayVoiceStatus()).toBeUndefined();
        });

        it('never throws across IPC: unexpected errors become internal-error', async () => {
            mockResolve.mockImplementationOnce(() => {
                throw new Error('boom');
            });
            expect(await call(CH.GET_CAPABILITIES, wcA)).toEqual({ok: false, error: 'internal-error'});
        });
    });

    describe('capabilities', () => {
        it('reports linux/x11 with global keys', async () => {
            expect(await call(CH.GET_CAPABILITIES, wcA)).toMatchObject({
                version: BUFY_API_VERSION,
                platform: 'linux',
                overlay: true,
                overlayExcludedFromCapture: false,
                globalKeys: true,
                globalKeysBackend: 'uiohook',
                keyCapture: true,
                globalKeysPermission: 'not-required',
                shortcuts: true,
                tray: true,
                screenSharePicker: 'app',
            });
            expect(mockSetDisplayMedia).not.toHaveBeenCalled();
        });

        it('reports Wayland without a portal as globalKeys:false with a precise reason and no shortcuts', async () => {
            process.env.XDG_SESSION_TYPE = 'wayland';
            expect(await call(CH.GET_CAPABILITIES, wcA)).toMatchObject({globalKeys: false, globalKeysBackend: null, globalKeysReason: 'wayland-no-portal', keyCapture: false, shortcuts: false});
            expect(await call(CH.REGISTER_PTT, wcA, {key: 'F13'})).toMatchObject({ok: false, error: 'unsupported'});
            expect(mockHook.start).not.toHaveBeenCalled();
        });

        describe('Wayland with the GlobalShortcuts portal', () => {
            let portal: FakePortal;
            beforeEach(() => {
                process.env.XDG_SESSION_TYPE = 'wayland';
                portal = new FakePortal();
                mockConnectBus.mockImplementation(async () => {
                    portal.connectionClosed = false;
                    return portal.bus;
                });
            });

            it('reports the portal backend', async () => {
                expect(await call(CH.GET_CAPABILITIES, wcA)).toMatchObject({globalKeys: true, globalKeysBackend: 'portal', keyCapture: false, shortcuts: true});
            });

            it('push-to-talk: resolves with the bound trigger; down/up and trigger changes reach only the owner', async () => {
                portal.triggerFor = () => 'Ctrl+Alt+P';
                expect(await call(CH.REGISTER_PTT, wcA, {key: 'KeyP', modifiers: ['ctrl', 'alt']})).toEqual({ok: true, backend: 'portal', trigger: 'Ctrl+Alt+P', requestedTrigger: 'CTRL+ALT+p'});
                portal.activate('ptt');
                portal.deactivate('ptt');
                expect(wcA.send).toHaveBeenCalledWith(CH.EVENT_PTT_DOWN);
                expect(wcA.send).toHaveBeenCalledWith(CH.EVENT_PTT_UP);
                portal.shortcutsChanged([['ptt', {trigger_description: 'F14'}]]);
                expect(wcA.send).toHaveBeenCalledWith(CH.EVENT_TRIGGER_CHANGED, {id: 'ptt', trigger: 'F14'});
                expect(wcB.send).not.toHaveBeenCalled();
                expect(mockHook.start).not.toHaveBeenCalled();
            });

            it('toggles use the portal, not Electron globalShortcut', async () => {
                const res = await call(CH.REGISTER_SHORTCUT, wcB, {id: 'toggle-mute', accelerator: 'CommandOrControl+Shift+M'});
                expect(res).toMatchObject({ok: true, backend: 'portal'});
                expect(mockShortcuts.size).toBe(0);
                portal.activate('toggle-mute');
                expect(wcB.send).toHaveBeenCalledWith(CH.EVENT_SHORTCUT, 'toggle-mute');
                expect(wcA.send).not.toHaveBeenCalled();
            });

            it('captureNextKey answers unsupported-on-wayland even for an unfocused page', async () => {
                const bg = makeWebContents(3, false);
                expect(await call(CH.CAPTURE_NEXT_KEY, bg, {})).toMatchObject({ok: false, error: 'unsupported-on-wayland'});
            });

            it('releases a held key and closes the session when the view goes away', async () => {
                await call(CH.REGISTER_PTT, wcA, {key: 'F13'});
                portal.activate('ptt');
                wcA.emit('destroyed');
                expect(wcA.send).toHaveBeenCalledWith(CH.EVENT_PTT_UP);
                await new Promise((r) => setTimeout(r, 10));
                expect(portal.closedSessions).toEqual(portal.sessions);
            });

            it('app quit releases the held key and closes session + connection', async () => {
                await call(CH.REGISTER_PTT, wcA, {key: 'F13'});
                portal.activate('ptt');
                mockAppEmitter.emit('will-quit');
                expect(wcA.send).toHaveBeenCalledWith(CH.EVENT_PTT_UP);
                await new Promise((r) => setTimeout(r, 10));
                expect(portal.closed).toBe(true);
            });

            it('openShortcutSettings opens the compositor settings', async () => {
                await call(CH.REGISTER_PTT, wcA, {key: 'F13'});
                expect(await call(CH.OPEN_SHORTCUT_SETTINGS, wcA)).toEqual({ok: true});
            });
        });

        it('reports macOS permission denied and refuses PTT until granted', async () => {
            reinit('darwin');
            mockSystemPrefs.isTrustedAccessibilityClient.mockReturnValue(false);
            expect(await call(CH.GET_CAPABILITIES, wcA)).toMatchObject({globalKeys: false, globalKeysPermission: 'denied', globalKeysReason: 'permission-denied', overlayExcludedFromCapture: true});
            expect(await call(CH.REGISTER_PTT, wcA, {key: 'Space'})).toMatchObject({ok: false, error: 'permission-denied'});
            expect(mockHook.start).not.toHaveBeenCalled();

            mockSystemPrefs.isTrustedAccessibilityClient.mockReturnValue(true);
            expect(await call(CH.GET_CAPABILITIES, wcA)).toMatchObject({globalKeys: true, globalKeysPermission: 'granted'});
            expect(await call(CH.REGISTER_PTT, wcA, {key: 'Space'})).toEqual({ok: true, backend: 'uiohook'});
        });

        it('tray capability follows the tray icon', async () => {
            mockTray.isAvailable.mockReturnValue(false);
            expect(await call(CH.GET_CAPABILITIES, wcA)).toMatchObject({tray: false});
        });
    });

    describe('accessibility helper', () => {
        it('is a no-op error outside macOS', async () => {
            expect(await call(CH.OPEN_ACCESSIBILITY_SETTINGS, wcA)).toMatchObject({ok: false, error: 'unsupported'});
        });

        it('opens the Accessibility pane on macOS', async () => {
            reinit('darwin');
            // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
            const {shell} = require('electron');
            expect(await call(CH.OPEN_ACCESSIBILITY_SETTINGS, wcA)).toEqual({ok: true});
            expect(shell.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
            expect(mockSystemPrefs.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
        });
    });

    describe('input validation', () => {
        it('returns invalid-argument and does nothing', async () => {
            expect(await call(CH.REGISTER_PTT, wcA, {key: 'Nope'})).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(await call(CH.REGISTER_PTT, wcA, 'Space')).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(await call(CH.REGISTER_SHORTCUT, wcA, {id: 'a', accelerator: 'A'})).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(await call(CH.REGISTER_SHORTCUT, wcA, {id: '../x', accelerator: 'Ctrl+Alt+A'})).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(await call(CH.SHOW_SHARE_BORDER, wcA, {sourceId: 'x'})).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(await call(CH.SET_VOICE_STATUS, wcA, {connected: 'yes'})).toMatchObject({ok: false, error: 'invalid-argument'});
            expect(mockHook.start).not.toHaveBeenCalled();
            expect(mockShortcuts.size).toBe(0);
        });
    });

    describe('event routing', () => {
        it('push-to-talk events only reach the registering view', async () => {
            expect(await call(CH.REGISTER_PTT, wcA, {key: 'Mouse4'})).toEqual({ok: true, backend: 'uiohook'});
            emitHook('mousedown', {button: 4});
            emitHook('mouseup', {button: 4});
            expect(wcA.send.mock.calls).toEqual([[CH.EVENT_PTT_DOWN], [CH.EVENT_PTT_UP]]);
            expect(wcB.send).not.toHaveBeenCalled();
        });

        it('shortcut events carry the plugin id and only reach the owner', async () => {
            expect(await call(CH.REGISTER_SHORTCUT, wcB, {id: 'toggle-mute', accelerator: 'CommandOrControl+Shift+M'})).toEqual({ok: true, backend: 'electron'});
            mockShortcuts.get('commandorcontrol+shift+m')!();
            expect(wcB.send).toHaveBeenCalledWith(CH.EVENT_SHORTCUT, 'toggle-mute');
            expect(wcA.send).not.toHaveBeenCalled();
        });

        it('a second view cannot take an accelerator held by the first', async () => {
            await call(CH.REGISTER_SHORTCUT, wcA, {id: 'm', accelerator: 'Ctrl+Alt+M'});
            expect(await call(CH.REGISTER_SHORTCUT, wcB, {id: 'm', accelerator: 'Ctrl+Alt+M'})).toMatchObject({ok: false, error: 'in-use'});
        });

        it('tray menu actions go back to the view that set the status', async () => {
            expect(await call(CH.SET_VOICE_STATUS, wcA, {connected: true, roomName: 'Lobby'})).toEqual({ok: true});
            expect(mockTray.refresh).toHaveBeenCalled();
            expect(mockTray.setMenu).toHaveBeenCalled();
            const {getVoiceTrayMenuTemplate} = jest.requireActual('./trayStatus');
            const items = getVoiceTrayMenuTemplate();
            items.find((i: {label?: string}) => i.label === 'Mute').click();
            expect(wcA.send).toHaveBeenCalledWith(CH.EVENT_TRAY_ACTION, 'toggleMute');
            expect(wcB.send).not.toHaveBeenCalled();
        });

        it('does not deliver to destroyed webContents', async () => {
            await call(CH.REGISTER_PTT, wcA, {key: 'Space'});
            wcA.isDestroyed = () => true;
            emitHook('keydown', {keycode: 57});
            expect(wcA.send).not.toHaveBeenCalled();
        });
    });

    describe('capture', () => {
        it('requires the page to be focused', async () => {
            const unfocused = makeWebContents(3, false);
            expect(await call(CH.CAPTURE_NEXT_KEY, unfocused, {})).toMatchObject({ok: false, error: 'permission-denied'});
            expect(mockHook.start).not.toHaveBeenCalled();
        });

        it('resolves with the next global key and is cancelable', async () => {
            const p = call(CH.CAPTURE_NEXT_KEY, wcA, {timeoutMs: 3000});
            await new Promise((r) => setImmediate(r));
            emitHook('keydown', {keycode: 57});
            expect(await p).toEqual({ok: true, captured: {key: 'Space', modifiers: [], type: 'keyboard'}});

            const p2 = call(CH.CAPTURE_NEXT_KEY, wcA, {timeoutMs: 3000});
            await new Promise((r) => setImmediate(r));
            await call(CH.CANCEL_CAPTURE, wcA);
            expect(await p2).toMatchObject({ok: false, error: 'cancelled'});
        });
    });

    describe('rate limiting', () => {
        it('limits overlay calls per view but not across views', async () => {
            const first = await call(CH.SHOW_SHARE_BORDER, wcA, {sourceId: 'screen:1:0'});
            expect(first).toMatchObject({ok: true});
            expect(await call(CH.SHOW_SHARE_BORDER, wcA, {sourceId: 'screen:1:0'})).toEqual({ok: false, error: 'rate-limited'});
            expect(await call(CH.HIDE_SHARE_BORDER, wcA)).toEqual({ok: true}); // hide is never rate limited
        });

        it('Wayland: the system picker is the only one, so no border and getDisplayMedia goes through our handler', async () => {
            process.env.XDG_SESSION_TYPE = 'wayland';
            reinit('linux');
            expect(await call(CH.GET_CAPABILITIES, wcA)).toMatchObject({overlay: false, screenSharePicker: 'system'});
            expect(mockSetDisplayMedia).toHaveBeenCalledTimes(1);
            expect(typeof mockSetDisplayMedia.mock.calls[0][0]).toBe('function');

            // showing a border would list the sources, i.e. open the portal picker again
            const {desktopCapturer} = jest.requireMock('electron');
            desktopCapturer.getSources.mockClear();
            expect(await call(CH.SHOW_SHARE_BORDER, wcB, {sourceId: 'screen:1:0'})).toMatchObject({ok: false, error: 'unsupported'});
            expect(desktopCapturer.getSources).not.toHaveBeenCalled();
            expect(mockOverlayShow).not.toHaveBeenCalled();
        });

        it('limits voice status updates', async () => {
            expect(await call(CH.SET_VOICE_STATUS, wcA, {connected: true})).toEqual({ok: true});
            expect(await call(CH.SET_VOICE_STATUS, wcA, {connected: true, muted: true})).toEqual({ok: false, error: 'rate-limited'});
        });

        it('refuses voice status without a tray', async () => {
            mockTray.isAvailable.mockReturnValue(false);
            expect(await call(CH.SET_VOICE_STATUS, wcA, {connected: true})).toMatchObject({ok: false, error: 'unsupported'});
        });
    });

    describe('cleanup', () => {
        const setup = async () => {
            await call(CH.REGISTER_PTT, wcA, {key: 'Space'});
            await call(CH.REGISTER_SHORTCUT, wcA, {id: 'm', accelerator: 'Ctrl+Alt+M'});
            await call(CH.SET_VOICE_STATUS, wcA, {connected: true});
            await call(CH.SHOW_SHARE_BORDER, wcA, {sourceId: 'screen:1:0'});

            // another view that must stay untouched
            await call(CH.REGISTER_SHORTCUT, wcB, {id: 'k', accelerator: 'Ctrl+Alt+K'});
        };
        const expectCleared = () => {
            expect(mockShortcuts.has('ctrl+alt+m')).toBe(false);
            expect(mockShortcuts.has('ctrl+alt+k')).toBe(true);
            expect(getTrayVoiceStatus()).toBeUndefined();
            expect(mockHook.stop).toHaveBeenCalled();
            emitHook('keydown', {keycode: 57});
            expect(wcA.send).not.toHaveBeenCalled();
        };

        it('when the webContents is destroyed', async () => {
            await setup();
            wcA.emit('destroyed');
            expectCleared();
        });

        it('when the renderer crashes', async () => {
            await setup();
            wcA.emit('render-process-gone');
            expectCleared();
        });

        it('when the page navigates to a new document, but not for same-document navigation or subframes', async () => {
            await setup();
            wcA.emit('did-start-navigation', {isMainFrame: true, isSameDocument: true});
            wcA.emit('did-start-navigation', {isMainFrame: false, isSameDocument: false});
            expect(mockShortcuts.has('ctrl+alt+m')).toBe(true);
            wcA.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false});
            expectCleared();
        });

        it('when its view/server is removed', async () => {
            await setup();
            mockViewManager.emit('view-removed', 'view-1', 'srv');
            expectCleared();
        });

        it('on app quit', async () => {
            await setup();
            mockAppEmitter.emit('will-quit');
            expect(mockShortcuts.size).toBe(0);
            expect(mockHook.stop).toHaveBeenCalled();
            expect(getTrayVoiceStatus()).toBeUndefined();
        });

        it('does not leave listeners behind after releasing', async () => {
            await setup();
            wcA.emit('destroyed');
            expect(wcA.listenerCount('destroyed')).toBe(0);
            expect(wcA.listenerCount('did-start-navigation')).toBe(0);
        });
    });
});
