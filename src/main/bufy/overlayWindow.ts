// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: the transparent, click-through, always-on-top frame window used as the screen-share border.
// It only ever loads the inline page below (no network, no preload, no node, sandboxed, devtools off).

import {BrowserWindow} from 'electron';

import type {Rect} from './geometry';

export type OverlayWindowLike = {
    setBounds: (bounds: Rect) => void;
    showInactive: () => void;
    hide: () => void;
    destroy: () => void;
    isDestroyed: () => boolean;
    isVisible: () => boolean;
};

export type OverlayStyle = {color: string; thickness: number};

export function buildOverlayHtml({color, thickness}: OverlayStyle): string {
    // color/thickness were validated by the caller (hex/rgb only, integer 1-12); never interpolate unvalidated input.
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
        '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden;pointer-events:none}' +
        `#f{position:fixed;inset:0;box-sizing:border-box;border:${thickness}px solid ${color};pointer-events:none}</style></head>` +
        '<body><div id="f"></div></body></html>';
}

export function overlayWindowOptions(bounds: Rect): Electron.BrowserWindowConstructorOptions {
    return {
        ...bounds,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        alwaysOnTop: true,
        enableLargerThanScreen: true,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            devTools: false,
            spellcheck: false,
            partition: 'bufy-overlay', // in-memory, separate from every server session
        },
    };
}

export function createOverlayWindow(bounds: Rect, style: OverlayStyle, platform: NodeJS.Platform = process.platform): OverlayWindowLike {
    const win = new BrowserWindow(overlayWindowOptions(bounds));

    // Click-through (mouse events fall through to whatever is below), also forwarded so hover still works underneath.
    win.setIgnoreMouseEvents(true, {forward: true});
    win.setAlwaysOnTop(true, 'screen-saver');
    if (platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true});
    }

    // Keep the frame out of the captured stream where the OS lets us (Windows 10 2004+ / macOS without ScreenCaptureKit).
    if (platform === 'win32' || platform === 'darwin') {
        win.setContentProtection(true);
    }

    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('page-title-updated', (e) => e.preventDefault());

    // `browser-window-created` handlers upstream may reposition new windows: always apply our bounds last.
    win.setBounds(bounds);
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml(style))}`);

    return {
        setBounds: (b) => win.setBounds(b),
        showInactive: () => win.showInactive(),
        hide: () => win.hide(),
        destroy: () => {
            if (!win.isDestroyed()) {
                // `closable:false` blocks close() on some platforms; destroy() always works.
                win.destroy();
            }
        },
        isDestroyed: () => win.isDestroyed(),
        isVisible: () => win.isVisible(),
    };
}
