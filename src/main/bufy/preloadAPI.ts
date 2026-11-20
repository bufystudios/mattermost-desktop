// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: preload side of `window.desktopAPI.bufy`. Bundled into the externalAPI preload.
// Every call resolves to a result object; main-process errors never reach the page as rejections.

import type {IpcRendererEvent} from 'electron';
import {ipcRenderer} from 'electron';

import {BUFY_API_VERSION, BUFY_CHANNELS as CH} from './shared';
import type {BufyAPI, BufyFailure} from './shared';

const createListener = (channel: string, listener: (...args: never[]) => void) => {
    const wrapped = (_: IpcRendererEvent, ...args: unknown[]) => listener(...args as never[]);
    ipcRenderer.on(channel, wrapped);
    return () => {
        ipcRenderer.off(channel, wrapped);
    };
};

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    try {
        const res = await ipcRenderer.invoke(channel, ...args);
        return (res ?? {ok: false, error: 'internal-error'}) as T;
    } catch {
        return {ok: false, error: 'internal-error'} as BufyFailure as T;
    }
};

export function createBufyAPI(): BufyAPI {
    return Object.freeze<BufyAPI>({
        version: BUFY_API_VERSION,
        getCapabilities: () => invoke(CH.GET_CAPABILITIES),

        showShareBorder: (opts) => invoke(CH.SHOW_SHARE_BORDER, opts),
        hideShareBorder: () => invoke(CH.HIDE_SHARE_BORDER),
        onShareBorderLost: (listener) => createListener(CH.EVENT_SHARE_BORDER_LOST, () => listener()),

        registerPushToTalk: (opts) => invoke(CH.REGISTER_PTT, opts),
        unregisterPushToTalk: () => invoke(CH.UNREGISTER_PTT),
        onPttDown: (listener) => createListener(CH.EVENT_PTT_DOWN, () => listener()),
        onPttUp: (listener) => createListener(CH.EVENT_PTT_UP, () => listener()),
        captureNextKey: (opts) => invoke(CH.CAPTURE_NEXT_KEY, opts ?? {}),
        cancelCaptureKey: () => invoke(CH.CANCEL_CAPTURE),
        openAccessibilitySettings: () => invoke(CH.OPEN_ACCESSIBILITY_SETTINGS),
        openShortcutSettings: () => invoke(CH.OPEN_SHORTCUT_SETTINGS),

        registerShortcut: (opts) => invoke(CH.REGISTER_SHORTCUT, opts),
        unregisterShortcut: (id) => invoke(CH.UNREGISTER_SHORTCUT, id),
        onShortcut: (listener) => createListener(CH.EVENT_SHORTCUT, (id: never) => listener(id)),
        onShortcutTriggerChanged: (listener) => createListener(CH.EVENT_TRIGGER_CHANGED, (change: never) => listener(change)),

        setVoiceStatus: (status) => invoke(CH.SET_VOICE_STATUS, status),
        onTrayAction: (listener) => createListener(CH.EVENT_TRAY_ACTION, (action: never) => listener(action)),
    });
}

/** Adds `bufy` to the upstream desktopAPI object that is exposed to server pages. */
export function withBufyAPI<T extends object>(api: T): T & {bufy: BufyAPI} {
    return {...api, bufy: createBufyAPI()};
}
