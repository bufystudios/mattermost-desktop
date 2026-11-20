// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {displayForRect, isUsableRect, parseSourceId, rectsEqual, roundRect} from './geometry';
import type {Rect} from './geometry';
import {OVERLAY_POLL_MS, ShareBorder} from './overlay';
import type {OverlayDeps} from './overlay';
import type {OverlayWindowLike} from './overlayWindow';
import type {WindowBoundsProvider, WindowBoundsResult} from './windowBounds';

const STYLE = {color: '#e5252a', thickness: 3};
const DISPLAY_A = {id: 60, bounds: {x: 0, y: 0, width: 1920, height: 1080}};
const DISPLAY_B = {id: 61, bounds: {x: 1920, y: 0, width: 1280, height: 1024}};

function fakeWindow(initial: Rect): OverlayWindowLike & {bounds: Rect; visible: boolean; destroyed: boolean} {
    const w = {
        bounds: initial,
        visible: false,
        destroyed: false,
        setBounds: jest.fn((b: Rect) => {
            w.bounds = b;
        }),
        showInactive: jest.fn(() => {
            w.visible = true;
        }),
        hide: jest.fn(() => {
            w.visible = false;
        }),
        destroy: jest.fn(() => {
            w.destroyed = true;
        }),
        isDestroyed: () => w.destroyed,
        isVisible: () => w.visible,
    };
    return w;
}

function make(opts: {
    sources?: Array<{id: string; display_id?: string}>;
    provider?: WindowBoundsProvider | undefined;
    displays?: Array<typeof DISPLAY_A>;
} = {}) {
    const windows: Array<ReturnType<typeof fakeWindow>> = [];
    const intervals: Array<{fn: () => void; id: number}> = [];
    let nextId = 1;
    const deps: OverlayDeps = {
        getSources: jest.fn().mockResolvedValue(opts.sources ?? [
            {id: 'screen:405:0', display_id: '60'},
            {id: 'screen:406:0', display_id: '61'},
            {id: 'window:2097177:1'},
        ]),
        getAllDisplays: () => opts.displays ?? [DISPLAY_A, DISPLAY_B],
        getPrimaryDisplay: () => DISPLAY_A,
        createWindow: jest.fn((bounds: Rect) => {
            const w = fakeWindow(bounds);
            windows.push(w);
            return w;
        }),
        boundsProvider: 'provider' in opts ? opts.provider : undefined,
        setInterval: ((fn: () => void) => {
            const id = nextId++;
            intervals.push({fn, id});
            return id as unknown as NodeJS.Timeout;
        }) as unknown as typeof setInterval,
        clearInterval: ((id: number) => {
            const i = intervals.findIndex((x) => x.id === id);
            if (i >= 0) {
                intervals.splice(i, 1);
            }
        }) as unknown as typeof clearInterval,
    };
    const onLost = jest.fn();
    const border = new ShareBorder(deps, onLost);
    const tick = () => intervals.forEach((i) => i.fn());
    return {border, deps, windows, intervals, onLost, tick};
}

function providerOf(states: WindowBoundsResult[]): WindowBoundsProvider & {calls: string[]} {
    let i = 0;
    const calls: string[] = [];
    return {
        calls,
        getBounds: (id: string) => {
            calls.push(id);
            const s = states[Math.min(i, states.length - 1)];
            i++;
            return s;
        },
    };
}

describe('bufy/geometry', () => {
    it('parses source ids', () => {
        expect(parseSourceId('screen:405:0')).toEqual({kind: 'screen', nativeId: '405'});
        expect(parseSourceId('window:2097177:1')).toEqual({kind: 'window', nativeId: '2097177'});
        expect(parseSourceId('window:abc:1')).toBeUndefined();
        expect(parseSourceId('screen:1')).toBeUndefined();
        expect(parseSourceId('screen:1:0; rm -rf')).toBeUndefined();
    });

    it('compares, rounds and sanity-checks rects', () => {
        expect(rectsEqual({x: 1, y: 2, width: 3, height: 4}, {x: 1, y: 2, width: 3, height: 4})).toBe(true);
        expect(rectsEqual({x: 1, y: 2, width: 3, height: 4}, {x: 1, y: 2, width: 3, height: 5})).toBe(false);
        expect(rectsEqual(undefined, undefined)).toBe(true);
        expect(roundRect({x: 1.4, y: 2.6, width: 3.5, height: 4.49})).toEqual({x: 1, y: 3, width: 4, height: 4});
        expect(isUsableRect({x: 0, y: 0, width: 0, height: 10})).toBe(false);
        expect(isUsableRect({x: NaN, y: 0, width: 10, height: 10})).toBe(false);
        expect(isUsableRect({x: -50, y: -20, width: 10, height: 10})).toBe(true);
    });

    it('picks the display with the largest overlap', () => {
        expect(displayForRect({x: 1800, y: 100, width: 600, height: 300}, [DISPLAY_A, DISPLAY_B])).toBe(DISPLAY_B);
        expect(displayForRect({x: 100, y: 100, width: 600, height: 300}, [DISPLAY_A, DISPLAY_B])).toBe(DISPLAY_A);
        expect(displayForRect({x: 9000, y: 9000, width: 10, height: 10}, [DISPLAY_A, DISPLAY_B])).toBe(DISPLAY_A);
    });
});

describe('bufy/ShareBorder', () => {
    it('frames the display matching a screen source (display_id)', async () => {
        const {border, windows, deps} = make();
        const res = await border.show(5, 'screen:406:0', STYLE);
        expect(res).toEqual({ok: true, target: 'display'});
        expect(deps.createWindow).toHaveBeenCalledWith(DISPLAY_B.bounds, STYLE);
        expect(windows[0].showInactive).toHaveBeenCalled();
        expect(border.ownerId).toBe(5);
    });

    it('rejects malformed ids and ids not offered by desktopCapturer', async () => {
        const {border, deps} = make();
        expect(await border.show(1, 'nope', STYLE)).toMatchObject({ok: false, error: 'invalid-argument'});
        expect(await border.show(1, 'screen:999:0', STYLE)).toMatchObject({ok: false, error: 'source-not-found'});
        expect(await border.show(1, 'window:42:0', STYLE)).toMatchObject({ok: false, error: 'source-not-found'});
        expect(deps.createWindow).not.toHaveBeenCalled();
    });

    it('fails when the display of a screen source is unknown', async () => {
        const {border} = make({sources: [{id: 'screen:7:0', display_id: '999'}]});
        expect(await border.show(1, 'screen:7:0', STYLE)).toMatchObject({ok: false, error: 'source-not-found'});
    });

    it('frames the window using its native bounds and follows moves/resizes', async () => {
        const provider = providerOf([
            {state: 'ok', bounds: {x: 100, y: 120, width: 800, height: 600}},
            {state: 'ok', bounds: {x: 100, y: 120, width: 800, height: 600}},
            {state: 'ok', bounds: {x: 300, y: 200, width: 1000, height: 700}},
        ]);
        const {border, windows, deps, tick} = make({provider});
        const res = await border.show(1, 'window:2097177:1', STYLE);
        expect(res).toEqual({ok: true, target: 'window'});
        expect(provider.calls[0]).toBe('2097177'); // native id, not the whole source id
        expect(deps.createWindow).toHaveBeenCalledWith({x: 100, y: 120, width: 800, height: 600}, STYLE);

        tick(); // unchanged -> no setBounds
        expect(windows[0].setBounds).not.toHaveBeenCalled();
        tick(); // moved + resized
        expect(windows[0].setBounds).toHaveBeenCalledWith({x: 300, y: 200, width: 1000, height: 700});
        expect(OVERLAY_POLL_MS).toBeLessThanOrEqual(200);
    });

    it('rounds fractional bounds before applying', async () => {
        const provider = providerOf([
            {state: 'ok', bounds: {x: 10.4, y: 10.6, width: 400.2, height: 300.7}},
            {state: 'ok', bounds: {x: 20.5, y: 10.6, width: 400.2, height: 300.7}},
        ]);
        const {border, windows, tick} = make({provider});
        await border.show(1, 'window:2097177:1', STYLE);
        expect(windows[0].bounds).toEqual({x: 10, y: 11, width: 400, height: 301});
        tick();
        expect(windows[0].bounds).toEqual({x: 21, y: 11, width: 400, height: 301});
    });

    it('hides the frame while the window is minimized and shows it again afterwards', async () => {
        const provider = providerOf([
            {state: 'ok', bounds: {x: 0, y: 0, width: 500, height: 400}},
            {state: 'minimized'},
            {state: 'ok', bounds: {x: 0, y: 0, width: 500, height: 400}},
        ]);
        const {border, windows, tick} = make({provider});
        await border.show(1, 'window:2097177:1', STYLE);
        expect(windows[0].visible).toBe(true);
        tick();
        expect(windows[0].visible).toBe(false);
        tick();
        expect(windows[0].visible).toBe(true);
    });

    it('removes the frame and notifies the owner when the shared window disappears', async () => {
        const provider = providerOf([{state: 'ok', bounds: {x: 0, y: 0, width: 500, height: 400}}, {state: 'gone'}]);
        const {border, windows, tick, onLost, intervals} = make({provider});
        await border.show(9, 'window:2097177:1', STYLE);
        tick();
        expect(windows[0].destroyed).toBe(true);
        expect(onLost).toHaveBeenCalledWith(9);
        expect(border.isShowing).toBe(false);
        expect(intervals).toHaveLength(0);
    });

    it('falls back to framing the display when bounds cannot be read at all', async () => {
        const provider = providerOf([{state: 'error'}]);
        const {border, deps} = make({provider});
        expect(await border.show(1, 'window:2097177:1', STYLE)).toEqual({ok: true, target: 'display'});
        expect(deps.createWindow).toHaveBeenCalledWith(DISPLAY_A.bounds, STYLE);
    });

    it('falls back to framing the display when there is no provider (e.g. Wayland)', async () => {
        const {border, deps, intervals} = make({provider: undefined});
        expect(await border.show(1, 'window:2097177:1', STYLE)).toEqual({ok: true, target: 'display'});
        expect(deps.createWindow).toHaveBeenCalledWith(DISPLAY_A.bounds, STYLE);
        expect(intervals).toHaveLength(0); // nothing to poll
    });

    it('stops following and frames the display the window was on after repeated read errors', async () => {
        const provider = providerOf([
            {state: 'ok', bounds: {x: 2000, y: 100, width: 600, height: 400}}, // on display B
            {state: 'error'},
        ]);
        const {border, windows, tick, intervals} = make({provider});
        await border.show(1, 'window:2097177:1', STYLE);
        for (let i = 0; i < 5; i++) {
            tick();
        }
        expect(windows[0].bounds).toEqual(DISPLAY_B.bounds);
        expect(intervals).toHaveLength(0);
        expect(border.current?.target).toBe('display');
    });

    it('fails with source-not-found if the window is already gone', async () => {
        const {border, deps} = make({provider: providerOf([{state: 'gone'}])});
        expect(await border.show(1, 'window:2097177:1', STYLE)).toMatchObject({ok: false, error: 'source-not-found'});
        expect(deps.createWindow).not.toHaveBeenCalled();
    });

    it('only ever has one frame: a new show replaces the previous one', async () => {
        const {border, windows} = make();
        await border.show(1, 'screen:405:0', STYLE);
        await border.show(2, 'screen:406:0', STYLE);
        expect(windows[0].destroyed).toBe(true);
        expect(windows[1].destroyed).toBe(false);
        expect(border.ownerId).toBe(2);
    });

    it('a stale in-flight show does not create a window after a newer call', async () => {
        const {border, deps, windows} = make();
        let release: (v: unknown[]) => void = () => {};
        (deps.getSources as jest.Mock).mockImplementationOnce(() => new Promise((r) => {
            release = r;
        }));
        const first = border.show(1, 'screen:405:0', STYLE);
        const second = border.show(1, 'screen:406:0', STYLE);
        await second;
        release([{id: 'screen:405:0', display_id: '60'}]);
        expect(await first).toMatchObject({ok: false, error: 'cancelled'});
        expect(windows).toHaveLength(1);
        expect(deps.createWindow).toHaveBeenCalledTimes(1);
    });

    it('hide right after show wins: an in-flight show of the same owner does not create a frame', async () => {
        const {border, deps, windows} = make();
        let release: (v: unknown[]) => void = () => {};
        (deps.getSources as jest.Mock).mockImplementationOnce(() => new Promise((r) => {
            release = r;
        }));
        const pending = border.show(1, 'screen:405:0', STYLE);
        border.releaseOwner(1);
        release([{id: 'screen:405:0', display_id: '60'}]);
        expect(await pending).toMatchObject({ok: false, error: 'cancelled'});
        expect(windows).toHaveLength(0);
    });

    it('releaseOwner of another owner does not cancel an in-flight show', async () => {
        const {border, deps, windows} = make();
        let release: (v: unknown[]) => void = () => {};
        (deps.getSources as jest.Mock).mockImplementationOnce(() => new Promise((r) => {
            release = r;
        }));
        const pending = border.show(1, 'screen:405:0', STYLE);
        border.releaseOwner(2);
        release([{id: 'screen:405:0', display_id: '60'}]);
        expect(await pending).toMatchObject({ok: true});
        expect(windows).toHaveLength(1);
    });

    it('releaseOwner only hides the owner\'s frame; hide/dispose clean up the polling timer', async () => {
        const provider = providerOf([{state: 'ok', bounds: {x: 0, y: 0, width: 500, height: 400}}]);
        const {border, windows, intervals} = make({provider});
        await border.show(1, 'window:2097177:1', STYLE);
        border.releaseOwner(2);
        expect(border.isShowing).toBe(true);
        border.releaseOwner(1);
        expect(border.isShowing).toBe(false);
        expect(windows[0].destroyed).toBe(true);
        expect(intervals).toHaveLength(0);

        await border.show(1, 'window:2097177:1', STYLE);
        border.dispose();
        expect(intervals).toHaveLength(0);
    });

    it('surfaces enumeration failures as internal-error', async () => {
        const {border, deps} = make();
        (deps.getSources as jest.Mock).mockRejectedValueOnce(new Error('denied'));
        expect(await border.show(1, 'screen:405:0', STYLE)).toMatchObject({ok: false, error: 'internal-error'});
    });
});
