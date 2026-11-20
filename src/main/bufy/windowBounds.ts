// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: reads the on-screen bounds of *another application's* window from its native id, so the
// share border can follow the shared window. Everything is read-only polling through koffi FFI.
//
//  - Windows: user32/dwmapi (HWND from `window:<hwnd>:0`), DWM extended frame bounds (no invisible resize border)
//  - macOS:   CoreGraphics CGWindowListCreateDescriptionFromArray (CGWindowID)           [not verified on hardware yet]
//  - Linux:   libxcb on X11 sessions (X11 window id). Wayland has no equivalent -> undefined -> display fallback.
//
// Any failure resolves to `unsupported`/`error` so the caller can fall back to framing the display.

import koffi from 'koffi';

import {Logger} from 'common/log';

import type {Rect} from './geometry';

const log = new Logger('Bufy.WindowBounds');

export type WindowBoundsResult =
    | {state: 'ok'; bounds: Rect} // DIP, screen coordinates (what Electron's setBounds expects)
    | {state: 'minimized'} // exists but is not visible on screen right now
    | {state: 'gone'}
    | {state: 'error'};

export interface WindowBoundsProvider {
    getBounds(nativeId: string): WindowBoundsResult;
}

type Koffi = typeof koffi;

export function createWindowBoundsProvider(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    toDipRect?: (physical: Rect) => Rect,
): WindowBoundsProvider | undefined {
    try {
        switch (platform) {
        case 'win32':
            return createWindowsProvider(koffi, toDipRect ?? ((r) => r));
        case 'darwin':
            return createMacProvider(koffi);
        case 'linux':
            if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY || !env.DISPLAY) {
                return undefined;
            }
            return createXcbProvider(koffi);
        default:
            return undefined;
        }
    } catch (err) {
        log.warn('window bounds provider unavailable, falling back to display framing', {err});
        return undefined;
    }
}

function createWindowsProvider(koffi: Koffi, toDipRect: (r: Rect) => Rect): WindowBoundsProvider {
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    koffi.struct('BufyRECT', {left: 'int32', top: 'int32', right: 'int32', bottom: 'int32'});
    const isWindow = user32.func('bool __stdcall IsWindow(uintptr_t hwnd)');
    const isIconic = user32.func('bool __stdcall IsIconic(uintptr_t hwnd)');
    const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)');
    const getWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ BufyRECT *rect)');
    const dwmGetWindowAttribute = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, _Out_ BufyRECT *rect, uint32 size)');
    const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const DWMWA_CLOAKED = 14;
    const dwmGetCloaked = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, _Out_ uint32 *value, uint32 size)');

    return {
        getBounds: (nativeId) => {
            try {
                const hwnd = Number(nativeId);
                if (!isWindow(hwnd)) {
                    return {state: 'gone'};
                }
                if (isIconic(hwnd) || !isWindowVisible(hwnd)) {
                    return {state: 'minimized'};
                }
                const cloaked: number[] = [0];
                if (dwmGetCloaked(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) {
                    // other virtual desktop / hidden UWP window
                    return {state: 'minimized'};
                }
                const rect = {left: 0, top: 0, right: 0, bottom: 0};
                const ok = dwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) === 0 || getWindowRect(hwnd, rect);
                if (!ok) {
                    return {state: 'error'};
                }
                return {state: 'ok', bounds: toDipRect({x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top})};
            } catch (err) {
                log.debug('win32 getBounds failed', {err});
                return {state: 'error'};
            }
        },
    };
}

function createMacProvider(koffi: Koffi): WindowBoundsProvider {
    const FRAMEWORKS = '/System/Library/Frameworks';
    const CG = koffi.load(`${FRAMEWORKS}/CoreGraphics.framework/CoreGraphics`);
    const CF = koffi.load(`${FRAMEWORKS}/CoreFoundation.framework/CoreFoundation`);
    koffi.struct('BufyCGRect', {x: 'double', y: 'double', width: 'double', height: 'double'});
    const kCFStringEncodingUTF8 = 0x08000100;

    const cfStringCreate = CF.func('void *CFStringCreateWithCString(void *alloc, const char *cstr, uint32 encoding)');
    const cfRelease = CF.func('void CFRelease(void *cf)');
    const cfArrayCreate = CF.func('void *CFArrayCreate(void *alloc, uintptr_t *values, long count, void *callbacks)');
    const cfArrayGetCount = CF.func('long CFArrayGetCount(void *array)');
    const cfArrayGetValueAtIndex = CF.func('void *CFArrayGetValueAtIndex(void *array, long idx)');
    const cfDictionaryGetValue = CF.func('void *CFDictionaryGetValue(void *dict, void *key)');
    const cfBooleanGetValue = CF.func('bool CFBooleanGetValue(void *b)');
    const describe = CG.func('void *CGWindowListCreateDescriptionFromArray(void *windowIDs)');
    const rectFromDict = CG.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ BufyCGRect *rect)');

    const key = (s: string) => cfStringCreate(null, s, kCFStringEncodingUTF8);
    const kBounds = key('kCGWindowBounds');
    const kOnscreen = key('kCGWindowIsOnscreen');

    return {
        getBounds: (nativeId) => {
            let ids: unknown;
            let descs: unknown;
            try {
                ids = cfArrayCreate(null, [Number(nativeId)], 1, null);
                descs = describe(ids);
                if (!descs || cfArrayGetCount(descs) < 1) {
                    return {state: 'gone'};
                }
                const dict = cfArrayGetValueAtIndex(descs, 0);
                const onscreen = cfDictionaryGetValue(dict, kOnscreen);
                if (!onscreen || !cfBooleanGetValue(onscreen)) {
                    return {state: 'minimized'};
                }
                const boundsDict = cfDictionaryGetValue(dict, kBounds);
                const rect = {x: 0, y: 0, width: 0, height: 0};
                if (!boundsDict || !rectFromDict(boundsDict, rect)) {
                    return {state: 'error'};
                }

                // CoreGraphics global coordinates are already top-left based points == Electron DIP on macOS.
                return {state: 'ok', bounds: rect};
            } catch (err) {
                log.debug('darwin getBounds failed', {err});
                return {state: 'error'};
            } finally {
                if (descs) {
                    cfRelease(descs);
                }
                if (ids) {
                    cfRelease(ids);
                }
            }
        },
    };
}

function createXcbProvider(koffi: Koffi): WindowBoundsProvider | undefined {
    const xcb = koffi.load('libxcb.so.1');
    const libc = koffi.load('libc.so.6');

    // Replies are malloc'ed structs that we decode and free.
    const GeometryReply = koffi.struct('BufyXcbGeometryReply', {
        response_type: 'uint8',
        depth: 'uint8',
        sequence: 'uint16',
        length: 'uint32',
        root: 'uint32',
        x: 'int16',
        y: 'int16',
        width: 'uint16',
        height: 'uint16',
        border_width: 'uint16',
        pad: 'uint16',
    });
    const TranslateReply = koffi.struct('BufyXcbTranslateReply', {
        response_type: 'uint8',
        same_screen: 'uint8',
        sequence: 'uint16',
        length: 'uint32',
        child: 'uint32',
        dst_x: 'int16',
        dst_y: 'int16',
    });
    const AttributesReply = koffi.struct('BufyXcbAttributesReply', {
        response_type: 'uint8',
        backing_store: 'uint8',
        sequence: 'uint16',
        length: 'uint32',
        visual: 'uint32',
        cls: 'uint16',
        bit_gravity: 'uint8',
        win_gravity: 'uint8',
        backing_planes: 'uint32',
        backing_pixel: 'uint32',
        save_under: 'uint8',
        map_is_installed: 'uint8',
        map_state: 'uint8',
        override_redirect: 'uint8',
        colormap: 'uint32',
        all_event_masks: 'uint32',
        your_event_mask: 'uint32',
        do_not_propagate_mask: 'uint16',
        pad: 'uint16',
    });
    koffi.struct('BufyXcbCookie', {sequence: 'uint32'});

    const connect = xcb.func('void *xcb_connect(const char *name, _Out_ int *screen)');
    const connError = xcb.func('int xcb_connection_has_error(void *c)');
    const disconnect = xcb.func('void xcb_disconnect(void *c)');
    const getGeometry = xcb.func('BufyXcbCookie xcb_get_geometry(void *c, uint32 drawable)');
    const getGeometryReply = xcb.func('void *xcb_get_geometry_reply(void *c, BufyXcbCookie cookie, _Out_ void **err)');
    const translate = xcb.func('BufyXcbCookie xcb_translate_coordinates(void *c, uint32 src, uint32 dst, int16 x, int16 y)');
    const translateReply = xcb.func('void *xcb_translate_coordinates_reply(void *c, BufyXcbCookie cookie, _Out_ void **err)');
    const getAttrs = xcb.func('BufyXcbCookie xcb_get_window_attributes(void *c, uint32 window)');
    const getAttrsReply = xcb.func('void *xcb_get_window_attributes_reply(void *c, BufyXcbCookie cookie, _Out_ void **err)');

    // Replies are malloc'ed by libxcb. Electron/Chromium routes malloc/free through its own allocator shim, so the `free`
    // must be the one the process resolves globally (dlsym(RTLD_DEFAULT)), not the one bound to libc.so.6 directly.
    const dlsym = libc.func('void *dlsym(void *handle, const char *name)');
    const freeProto = koffi.proto('void BufyFree(void *p)');
    const freePtr = dlsym(null, 'free');
    if (!freePtr) {
        return undefined;
    }
    const free = (p: unknown) => koffi.call(freePtr, freeProto, p);

    let conn: unknown;
    const connection = () => {
        if (!conn) {
            const screen = [0];
            const c = connect(null, screen);
            if (!c || connError(c)) {
                if (c) {
                    disconnect(c);
                }
                throw new Error('xcb_connect failed');
            }
            conn = c;
        }
        return conn;
    };

    const decodeAndFree = <T>(ptr: unknown, type: unknown): T | undefined => {
        if (!ptr) {
            return undefined;
        }
        try {
            return koffi.decode(ptr, type as never) as T;
        } finally {
            free(ptr);
        }
    };

    return {
        getBounds: (nativeId) => {
            try {
                const c = connection();
                const win = Number(nativeId);

                const attrs = decodeAndFree<{map_state: number}>(getAttrsReply(c, getAttrs(c, win), [null]), AttributesReply);
                if (!attrs) {
                    return {state: 'gone'};
                }
                if (attrs.map_state !== 2) { // XCB_MAP_STATE_VIEWABLE
                    return {state: 'minimized'};
                }
                const geo = decodeAndFree<{root: number; width: number; height: number}>(getGeometryReply(c, getGeometry(c, win), [null]), GeometryReply);
                if (!geo) {
                    return {state: 'gone'};
                }
                const tr = decodeAndFree<{dst_x: number; dst_y: number}>(translateReply(c, translate(c, win, geo.root, 0, 0), [null]), TranslateReply);
                if (!tr) {
                    return {state: 'error'};
                }
                return {state: 'ok', bounds: {x: tr.dst_x, y: tr.dst_y, width: geo.width, height: geo.height}};
            } catch (err) {
                log.debug('xcb getBounds failed', {err});
                conn = undefined;
                return {state: 'error'};
            }
        },
    };
}
