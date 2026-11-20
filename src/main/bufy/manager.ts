// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: wires the bufy API (desktopAPI.bufy) to the main process.
//
// Every handler: (1) rate limit, (2) resolve the sender as a trusted Mattermost server page, (3) validate the
// payload, (4) act, (5) always answer with a result object (never throws across IPC).
// All OS-level state (PTT binding, shortcuts, overlay, tray status) is owned by one webContents and removed when
// that webContents is destroyed, navigates away, crashes, or its view/server is removed, and on app quit.

import type {IpcMainEvent, IpcMainInvokeEvent, WebContents} from 'electron';
import {app, desktopCapturer, globalShortcut, ipcMain, screen, shell, systemPreferences, webContents as allWebContents} from 'electron';

import createTrayMenu from 'app/menus/tray';
import Tray from 'app/system/tray/tray';
import {VIEW_REMOVED} from 'common/communication';
import {Logger} from 'common/log';
import ViewManager from 'common/views/viewManager';

import {GlobalKeys} from './globalKeys';
import type {HookLike} from './globalKeys';
import {KeysBackend} from './keysBackend';
import {ShareBorder} from './overlay';
import {createOverlayWindow} from './overlayWindow';
import {connectSessionBus} from './portalBus';
import {PortalKeys} from './portalKeys';
import {RateLimiter} from './rateLimiter';
import {resolveTrustedSender} from './security';
import type {TrustedSender} from './security';
import {BUFY_API_VERSION, BUFY_CHANNELS as CH, LIMITS} from './shared';
import type {
    BindingInfo,
    BufyCapabilities,
    BufyFailure,
    BufyResult,
    CapturedKey,
    PushToTalkOptions,
    ShareBorderOptions,
    ShareBorderResult,
    ShortcutOptions,
    TrayAction,
    VoiceStatus,
} from './shared';
import {ShortcutRegistry} from './shortcuts';
import {clearTrayVoiceStatus, configureTrayStatus, setTrayVoiceStatus} from './trayStatus';
import {
    captureSchema,
    isFailure,
    pushToTalkSchema,
    shareBorderSchema,
    shortcutIdSchema,
    shortcutSchema,
    validateArg,
    voiceStatusSchema,
} from './validation';
import {createWindowBoundsProvider} from './windowBounds';

const log = new Logger('Bufy');

const DEFAULT_COLOR = '#e5252a';
const DEFAULT_THICKNESS = 3;

type AnyEvent = IpcMainEvent | IpcMainInvokeEvent;
type VoidFn = () => void;

export class BufyManager {
    private initialized = false;
    private followsWindow = false;
    private keys?: KeysBackend;
    private overlay?: ShareBorder;
    private watched = new Map<number, VoidFn>();
    private viewOwners = new Map<string, Set<number>>();
    private overlayLimiter = new RateLimiter(LIMITS.overlayMinIntervalMs);
    private statusLimiter = new RateLimiter(LIMITS.statusMinIntervalMs);

    init = () => {
        if (this.initialized) {
            return;
        }
        this.initialized = true;

        const uiohook = new GlobalKeys({
            platform: process.platform,
            env: process.env,

            // Loaded lazily so a missing native dependency (e.g. libXt on Linux) only disables global keys.
            loadHook: async () => {
                const mod = await import('uiohook-napi');
                return mod.uIOhook as unknown as HookLike;
            },
            isAccessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
        });
        const shortcuts = new ShortcutRegistry(globalShortcut, (ownerId, id) => this.sendTo(ownerId, CH.EVENT_SHORTCUT, id));

        // Wayland: push-to-talk and shortcuts go through xdg-desktop-portal (D-Bus via dbus-native, loaded lazily).
        const portal = new PortalKeys({
            connect: () => connectSessionBus(),
            emitTrigger: (ownerId, change) => this.sendTo(ownerId, CH.EVENT_TRIGGER_CHANGED, change),
        });
        this.keys = new KeysBackend({platform: process.platform, env: process.env, uiohook, portal, shortcuts});
        const boundsProvider = createWindowBoundsProvider(
            process.platform,
            process.env,
            process.platform === 'win32' ? (r) => screen.screenToDipRect(null, r) : undefined,
        );
        this.followsWindow = Boolean(boundsProvider);
        this.overlay = new ShareBorder({
            getSources: () => desktopCapturer.getSources({types: ['screen', 'window'], thumbnailSize: {width: 0, height: 0}, fetchWindowIcons: false}),
            getAllDisplays: () => screen.getAllDisplays(),
            getPrimaryDisplay: () => screen.getPrimaryDisplay(),
            createWindow: createOverlayWindow,
            boundsProvider,
        }, (ownerId) => this.sendTo(ownerId, CH.EVENT_SHARE_BORDER_LOST));

        configureTrayStatus({
            onAction: (ownerId, action) => this.sendTo(ownerId, CH.EVENT_TRAY_ACTION, action),
            refresh: this.refreshTray,
        });

        ipcMain.handle(CH.GET_CAPABILITIES, this.guard(this.handleGetCapabilities));
        ipcMain.handle(CH.SHOW_SHARE_BORDER, this.guard(this.handleShowShareBorder));
        ipcMain.handle(CH.HIDE_SHARE_BORDER, this.guard(this.handleHideShareBorder));
        ipcMain.handle(CH.REGISTER_PTT, this.guard(this.handleRegisterPtt));
        ipcMain.handle(CH.UNREGISTER_PTT, this.guard(this.handleUnregisterPtt));
        ipcMain.handle(CH.REGISTER_SHORTCUT, this.guard(this.handleRegisterShortcut));
        ipcMain.handle(CH.UNREGISTER_SHORTCUT, this.guard(this.handleUnregisterShortcut));
        ipcMain.handle(CH.CAPTURE_NEXT_KEY, this.guard(this.handleCaptureNextKey));
        ipcMain.handle(CH.CANCEL_CAPTURE, this.guard(this.handleCancelCapture));
        ipcMain.handle(CH.OPEN_ACCESSIBILITY_SETTINGS, this.guard(this.handleOpenAccessibilitySettings));
        ipcMain.handle(CH.OPEN_SHORTCUT_SETTINGS, this.guard(this.handleOpenShortcutSettings));
        ipcMain.handle(CH.SET_VOICE_STATUS, this.guard(this.handleSetVoiceStatus));

        ViewManager.on(VIEW_REMOVED, this.handleViewRemoved);
        app.on('will-quit', this.dispose);
        log.info('initialized', {version: BUFY_API_VERSION});
    };

    dispose = () => {
        this.keys?.dispose();
        this.overlay?.dispose();
        clearTrayVoiceStatus();
        this.watched.forEach((unwatch) => unwatch());
        this.watched.clear();
    };

    /** Releases everything owned by a webContents (destroyed / navigated / crashed / view removed). */
    releaseOwner = (ownerId: number) => {
        this.keys?.releaseOwner(ownerId);
        this.overlay?.releaseOwner(ownerId);
        clearTrayVoiceStatus(ownerId);
        this.overlayLimiter.forget(ownerId);
        this.statusLimiter.forget(ownerId);
        this.watched.get(ownerId)?.();
        this.watched.delete(ownerId);
        this.viewOwners.forEach((set, viewId) => {
            set.delete(ownerId);
            if (set.size === 0) {
                this.viewOwners.delete(viewId);
            }
        });
    };

    // ---- plumbing ----

    private guard = <A extends unknown[]>(handler: (sender: TrustedSender, event: AnyEvent, ...args: A) => unknown | Promise<unknown>) => {
        return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> => {
            try {
                const sender = resolveTrustedSender(event);
                if (!sender) {
                    log.warn('rejected call from untrusted sender', {channel: 'bufy', webContentsId: event.sender?.id});
                    return {ok: false, error: 'untrusted-sender'} as BufyFailure;
                }
                return await handler(sender, event, ...(args as A));
            } catch (err) {
                log.error('handler failed', {err});
                return {ok: false, error: 'internal-error'} as BufyFailure;
            }
        };
    };

    private watch = (sender: TrustedSender, event: AnyEvent) => {
        if (sender.viewId) {
            const set = this.viewOwners.get(sender.viewId) ?? new Set<number>();
            set.add(sender.webContentsId);
            this.viewOwners.set(sender.viewId, set);
        }
        if (this.watched.has(sender.webContentsId)) {
            return;
        }
        const wc = event.sender;
        const id = sender.webContentsId;
        const release = () => this.releaseOwner(id);
        const onNavigate = (details: {isMainFrame: boolean; isSameDocument: boolean}) => {
            if (details.isMainFrame && !details.isSameDocument) {
                release();
            }
        };
        wc.once('destroyed', release);
        wc.once('render-process-gone', release);
        wc.on('did-start-navigation', onNavigate);
        this.watched.set(id, () => {
            if (!wc.isDestroyed()) {
                wc.off('destroyed', release);
                wc.off('render-process-gone', release);
                wc.off('did-start-navigation', onNavigate);
            }
        });
    };

    private handleViewRemoved = (viewId: string) => {
        const owners = this.viewOwners.get(viewId);
        if (owners) {
            [...owners].forEach(this.releaseOwner);
        }
    };

    private sendTo = (ownerId: number, channel: string, ...args: unknown[]) => {
        const wc: WebContents | undefined = allWebContents.fromId(ownerId);
        if (wc && !wc.isDestroyed()) {
            wc.send(channel, ...args);
        }
    };

    private refreshTray = () => {
        Tray.refresh();
        if (Tray.isAvailable()) {
            Tray.setMenu(createTrayMenu());
        }
    };

    private limited = (limiter: RateLimiter, sender: TrustedSender): BufyFailure | undefined => {
        return limiter.allow(sender.webContentsId) ? undefined : {ok: false, error: 'rate-limited'};
    };

    // ---- handlers ----

    handleGetCapabilities = async (): Promise<BufyCapabilities> => {
        const keys = await this.keys!.getStatus();
        const platform = process.platform;
        const win = platform === 'win32' || platform === 'darwin';
        return {
            version: BUFY_API_VERSION,
            platform,
            overlay: true,
            overlayExcludedFromCapture: win,
            overlayFollowsWindow: this.followsWindow,
            globalKeys: keys.available,
            globalKeysBackend: keys.backend,
            globalKeysReason: keys.reason,
            keyCapture: keys.available && this.keys!.keyCaptureSupported,
            globalKeysPermission: keys.permission,

            // Electron's globalShortcut elsewhere; on Wayland only through the portal
            shortcuts: !this.keys!.isWayland || keys.available,
            tray: Tray.isAvailable(),
        };
    };

    private handleShowShareBorder = async (sender: TrustedSender, event: AnyEvent, raw: unknown): Promise<ShareBorderResult> => {
        const limited = this.limited(this.overlayLimiter, sender);
        if (limited) {
            return limited;
        }
        const v = validateArg<ShareBorderOptions>(shareBorderSchema, raw);
        if (isFailure(v)) {
            return v;
        }
        this.watch(sender, event);
        return this.overlay!.show(sender.webContentsId, v.value.sourceId, {
            color: v.value.color ?? DEFAULT_COLOR,
            thickness: v.value.thickness ?? DEFAULT_THICKNESS,
        });
    };

    private handleHideShareBorder = (sender: TrustedSender): BufyResult => {
        // not rate limited: hiding is cheap and idempotent, and "stop sharing" right after "start" must always win
        this.overlay!.releaseOwner(sender.webContentsId);
        return {ok: true};
    };

    private handleRegisterPtt = async (sender: TrustedSender, event: AnyEvent, raw: unknown): Promise<BufyResult<BindingInfo>> => {
        const v = validateArg<PushToTalkOptions>(pushToTalkSchema, raw);
        if (isFailure(v)) {
            return v;
        }
        this.watch(sender, event);
        const id = sender.webContentsId;
        return this.keys!.registerPtt(
            id,
            v.value.key,
            v.value.modifiers,
            () => this.sendTo(id, CH.EVENT_PTT_DOWN),
            () => this.sendTo(id, CH.EVENT_PTT_UP),
        );
    };

    private handleUnregisterPtt = (sender: TrustedSender): BufyResult => this.keys!.unregisterPtt(sender.webContentsId);

    private handleRegisterShortcut = (sender: TrustedSender, event: AnyEvent, raw: unknown): Promise<BufyResult<BindingInfo>> | BufyFailure => {
        const v = validateArg<ShortcutOptions>(shortcutSchema, raw);
        if (isFailure(v)) {
            return v;
        }
        this.watch(sender, event);
        const id = sender.webContentsId;
        return this.keys!.registerShortcut(id, v.value.id, v.value.accelerator, () => this.sendTo(id, CH.EVENT_SHORTCUT, v.value.id));
    };

    private handleUnregisterShortcut = (sender: TrustedSender, event: AnyEvent, raw: unknown): BufyResult => {
        const v = validateArg<string>(shortcutIdSchema, raw);
        if (isFailure(v)) {
            return v;
        }
        return this.keys!.unregisterShortcut(sender.webContentsId, v.value);
    };

    private handleCaptureNextKey = (sender: TrustedSender, event: AnyEvent, raw: unknown): Promise<BufyResult<{captured: CapturedKey}>> | BufyFailure => {
        const v = validateArg<{timeoutMs?: number}>(captureSchema, raw ?? {});
        if (isFailure(v)) {
            return v;
        }

        if (this.keys!.isWayland) {
            // no global input hook on Wayland: the plugin should register a binding and let the system dialog assign the key
            return this.keys!.captureNextKey(sender.webContentsId, v.value.timeoutMs);
        }

        // Capturing reads the next *global* key press: only offer it to the focused page, and only while the
        // app window is in the foreground, so a background page cannot use it to observe typing elsewhere.
        if (!event.sender.isFocused()) {
            return {ok: false, error: 'permission-denied', message: 'captureNextKey requires the page to be focused'};
        }

        this.watch(sender, event);
        return this.keys!.captureNextKey(sender.webContentsId, v.value.timeoutMs);
    };

    private handleCancelCapture = (sender: TrustedSender): BufyResult => this.keys!.cancelCapture(sender.webContentsId);

    private handleOpenShortcutSettings = (): Promise<BufyResult> => this.keys!.openShortcutSettings();

    private handleOpenAccessibilitySettings = async (): Promise<BufyResult> => {
        if (process.platform !== 'darwin') {
            return {ok: false, error: 'unsupported', message: 'Only needed on macOS'};
        }

        // The prompt registers the app in the Accessibility list; the settings pane lets the user enable it.
        systemPreferences.isTrustedAccessibilityClient(true);
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        return {ok: true};
    };

    private handleSetVoiceStatus = (sender: TrustedSender, event: AnyEvent, raw: unknown): BufyResult => {
        const limited = this.limited(this.statusLimiter, sender);
        if (limited) {
            return limited;
        }
        const v = validateArg<VoiceStatus>(voiceStatusSchema, raw);
        if (isFailure(v)) {
            return v;
        }
        if (!Tray.isAvailable()) {
            return {ok: false, error: 'unsupported', message: 'Tray icon is disabled or unavailable'};
        }
        this.watch(sender, event);
        return setTrayVoiceStatus(sender.webContentsId, v.value);
    };
}

export type {TrayAction};

const bufyManager = new BufyManager();
export default bufyManager;
