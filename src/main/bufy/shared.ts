// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: types and IPC channel names shared by the main process and the preload script.
// This file must stay free of Electron/Node imports so the preload bundle can use it.

export const BUFY_API_VERSION = '1.0.0';

export const BUFY_CHANNELS = {
    GET_CAPABILITIES: 'bufy:get-capabilities',
    SHOW_SHARE_BORDER: 'bufy:show-share-border',
    HIDE_SHARE_BORDER: 'bufy:hide-share-border',
    REGISTER_PTT: 'bufy:register-ptt',
    UNREGISTER_PTT: 'bufy:unregister-ptt',
    REGISTER_SHORTCUT: 'bufy:register-shortcut',
    UNREGISTER_SHORTCUT: 'bufy:unregister-shortcut',
    CAPTURE_NEXT_KEY: 'bufy:capture-next-key',
    CANCEL_CAPTURE: 'bufy:cancel-capture',
    OPEN_ACCESSIBILITY_SETTINGS: 'bufy:open-accessibility-settings',
    SET_VOICE_STATUS: 'bufy:set-voice-status',

    // main -> renderer events
    EVENT_PTT_DOWN: 'bufy:event:ptt-down',
    EVENT_PTT_UP: 'bufy:event:ptt-up',
    EVENT_SHORTCUT: 'bufy:event:shortcut',
    EVENT_TRAY_ACTION: 'bufy:event:tray-action',
    EVENT_SHARE_BORDER_LOST: 'bufy:event:share-border-lost',
} as const;

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

export const LIMITS = {
    maxShortcutsPerView: 16,
    captureDefaultTimeoutMs: 8000,
    captureMaxTimeoutMs: 30000,
    overlayMinIntervalMs: 200, // at most 5 show/hide calls per second
    statusMinIntervalMs: 100, // at most 10 status updates per second
    maxRoomNameLength: 80,
    maxLabelLength: 40,
};
