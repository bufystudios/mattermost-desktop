// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {BrowserWindow} from 'electron';

import {buildOverlayHtml, createOverlayWindow, overlayWindowOptions} from './overlayWindow';

jest.mock('electron', () => ({
    BrowserWindow: jest.fn(),
}));

function mockWindow() {
    const win = {
        setIgnoreMouseEvents: jest.fn(),
        setAlwaysOnTop: jest.fn(),
        setVisibleOnAllWorkspaces: jest.fn(),
        setContentProtection: jest.fn(),
        setBounds: jest.fn(),
        loadURL: jest.fn(),
        on: jest.fn(),
        showInactive: jest.fn(),
        hide: jest.fn(),
        destroy: jest.fn(),
        isDestroyed: jest.fn().mockReturnValue(false),
        isVisible: jest.fn().mockReturnValue(true),
        webContents: {setWindowOpenHandler: jest.fn(), on: jest.fn()},
    };
    (BrowserWindow as unknown as jest.Mock).mockImplementation(() => win);
    return win;
}

const BOUNDS = {x: 10, y: 20, width: 300, height: 200};
const STYLE = {color: '#e5252a', thickness: 3};

describe('bufy/overlayWindow', () => {
    it('is transparent, frameless, non-focusable, always-on-top and sandboxed', () => {
        const o = overlayWindowOptions(BOUNDS);
        expect(o).toMatchObject({...BOUNDS, frame: false, transparent: true, focusable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, resizable: false});
        expect(o.webPreferences).toMatchObject({sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false});
        expect(o.webPreferences?.preload).toBeUndefined();
        expect(o.webPreferences?.partition).toBe('bufy-overlay'); // non-persistent session
    });

    it('is click-through (with forwarding) and above everything', () => {
        const win = mockWindow();
        createOverlayWindow(BOUNDS, STYLE, 'linux');
        expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true, {forward: true});
        expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    });

    it.each(['win32', 'darwin'] as const)('excludes the frame from screen capture on %s', (platform) => {
        const win = mockWindow();
        createOverlayWindow(BOUNDS, STYLE, platform);
        expect(win.setContentProtection).toHaveBeenCalledWith(true);
    });

    it('does not call the unsupported content protection API on linux', () => {
        const win = mockWindow();
        createOverlayWindow(BOUNDS, STYLE, 'linux');
        expect(win.setContentProtection).not.toHaveBeenCalled();
    });

    it('shows on all spaces incl. fullscreen apps on macOS only', () => {
        let win = mockWindow();
        createOverlayWindow(BOUNDS, STYLE, 'darwin');
        expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, expect.objectContaining({visibleOnFullScreen: true}));
        win = mockWindow();
        createOverlayWindow(BOUNDS, STYLE, 'win32');
        expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
    });

    it('applies its bounds after creation (upstream may reposition new windows) and loads only an inline page', () => {
        const win = mockWindow();
        createOverlayWindow(BOUNDS, STYLE, 'linux');
        expect(win.setBounds).toHaveBeenCalledWith(BOUNDS);
        const url = win.loadURL.mock.calls[0][0] as string;
        expect(url.startsWith('data:text/html')).toBe(true);
        expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({action: 'deny'});
    });

    it('destroys (not closes) the window and tolerates double destroy', () => {
        const win = mockWindow();
        const handle = createOverlayWindow(BOUNDS, STYLE, 'linux');
        handle.destroy();
        expect(win.destroy).toHaveBeenCalled();
        win.destroy.mockClear();
        win.isDestroyed.mockReturnValue(true);
        handle.destroy();
        expect(win.destroy).not.toHaveBeenCalled();
    });

    it('renders the configured color/thickness with a locked-down CSP', () => {
        const html = buildOverlayHtml({color: '#00ff00', thickness: 5});
        expect(html).toContain('border:5px solid #00ff00');
        expect(html).toContain("default-src 'none'");
        expect(html).toContain('pointer-events:none');
    });
});
