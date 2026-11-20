// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Types for `window.desktopAPI.bufy` (Bufy fork of the Mattermost desktop app).
// GENERATED from src/main/bufy/shared.ts by scripts/bufy-gen-types.js - do not edit by hand.
// Copy this file into a plugin or `import type` from it.
//
// Feature detection (works unchanged on the stock app, where `bufy` is simply undefined):
//
//   const bufy = (window as BufyWindow).desktopAPI?.bufy;
//   if (bufy) { const caps = await bufy.getCapabilities(); /* ... */ }

export declare const BUFY_API_VERSION: '1.0.0';

export type BufyErrorCode =
    | 'untrusted-sender' // call did not come from a trusted Mattermost server page
    | 'invalid-argument' // validation failed
    | 'rate-limited'
    | 'unsupported' // feature not available on this platform / session
    | 'permission-denied' // OS permission missing (macOS Accessibility)
    | 'source-not-found' // desktopCapturer id did not match any screen/window
    | 'in-use' // key/accelerator already registered by someone else
    | 'limit-reached' // too many shortcuts for this view
    | 'registration-failed' // OS refused the registration
    | 'timeout'
    | 'cancelled'
    | 'internal-error';

export type BufyOk<T = unknown> = {ok: true} & T;
export type BufyFailure = {ok: false; error: BufyErrorCode; message?: string};
export type BufyResult<T = unknown> = BufyOk<T> | BufyFailure;

export type ModifierName = 'ctrl' | 'alt' | 'shift' | 'meta';

export type BufyCapabilities = {

    /** API version (same as `desktopAPI.bufy.version`). */
    version: string;
    platform: 'win32' | 'darwin' | 'linux' | string;

    /** Screen-share border overlay can be shown. */
    overlay: boolean;

    /** Overlay uses setContentProtection so it is not visible in the captured stream (Windows/macOS only). */
    overlayExcludedFromCapture: boolean;

    /** Follows the shared *window* (true) or falls back to framing the whole display (false). */
    overlayFollowsWindow: boolean;

    /** Native global keyboard/mouse hook usable (push-to-talk, captureNextKey). */
    globalKeys: boolean;

    /** Why `globalKeys` is false (e.g. `wayland`, `no-display`, `permission-denied`, `native-module-failed`). */
    globalKeysReason?: string;

    /** macOS Accessibility permission state; `not-required` elsewhere. */
    globalKeysPermission: 'granted' | 'denied' | 'not-required';

    /** Electron globalShortcut accelerators (mute/deafen toggles). */
    shortcuts: boolean;

    /** Tray icon exists and can show voice status. */
    tray: boolean;
};

export type ShareBorderOptions = {

    /** desktopCapturer source id, `screen:...` or `window:...`. */
    sourceId: string;

    /** CSS color, default `#e5252a`. */
    color?: string;

    /** Border thickness in DIP (1-12), default 3. */
    thickness?: number;
};

export type ShareBorderResult = BufyResult<{

    /** What is actually framed: the shared window or (fallback) the display it is on. */
    target: 'window' | 'display';
}>;

export type PushToTalkOptions = {

    /**
     * KeyboardEvent.code-style name (`Space`, `KeyV`, `F13`, `ControlRight`, `Backquote`, `Numpad0` ...)
     * or a mouse button: `Mouse3` (middle), `Mouse4` (back), `Mouse5` (forward).
     */
    key: string;

    /** Modifiers that must be held when the key goes down. */
    modifiers?: ModifierName[];
};

export type CapturedKey = {
    key: string;
    modifiers: ModifierName[];
    type: 'keyboard' | 'mouse';
};

export type ShortcutOptions = {

    /** Plugin-chosen identifier, echoed back in `onShortcut`. */
    id: string;

    /** Electron accelerator, e.g. `CommandOrControl+Shift+M`. */
    accelerator: string;
};

export type VoiceStatus = {
    connected: boolean;
    muted?: boolean;
    deafened?: boolean;
    live?: boolean;
    roomName?: string;

    /** Optional (localised) menu labels supplied by the plugin. */
    labels?: Partial<Record<TrayLabelKey, string>>;
};

export type TrayLabelKey = 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'stopSharing' | 'leave';
export type TrayAction = 'toggleMute' | 'toggleDeafen' | 'stopSharing' | 'leave';

export type BufyAPI = {

    /** Present only in the Bufy build. Feature-detect with `window.desktopAPI.bufy?.version`. */
    readonly version: string;
    getCapabilities(): Promise<BufyCapabilities>;

    showShareBorder(opts: ShareBorderOptions): Promise<ShareBorderResult>;
    hideShareBorder(): Promise<BufyResult>;
    onShareBorderLost(listener: () => void): () => void;

    registerPushToTalk(opts: PushToTalkOptions): Promise<BufyResult>;
    unregisterPushToTalk(): Promise<BufyResult>;
    onPttDown(listener: () => void): () => void;
    onPttUp(listener: () => void): () => void;
    captureNextKey(opts?: {timeoutMs?: number}): Promise<BufyResult<{captured: CapturedKey}>>;
    cancelCaptureKey(): Promise<BufyResult>;
    openAccessibilitySettings(): Promise<BufyResult>;

    registerShortcut(opts: ShortcutOptions): Promise<BufyResult>;
    unregisterShortcut(id: string): Promise<BufyResult>;
    onShortcut(listener: (id: string) => void): () => void;

    setVoiceStatus(status: VoiceStatus): Promise<BufyResult>;
    onTrayAction(listener: (action: TrayAction) => void): () => void;
};

export type BufyWindow = Window & {desktopAPI?: {bufy?: BufyAPI}};
