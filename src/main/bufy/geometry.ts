// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: pure geometry helpers for the share-border overlay.

export type Rect = {x: number; y: number; width: number; height: number};

export function rectsEqual(a: Rect | undefined, b: Rect | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function roundRect(r: Rect): Rect {
    return {x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)};
}

export function isUsableRect(r: Rect): boolean {
    return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= 2 && r.height >= 2;
}

/** Intersection area of two rects (0 when they do not overlap). */
function overlapArea(a: Rect, b: Rect): number {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/** The display containing most of `target` (first display when nothing overlaps). */
export function displayForRect<D extends {bounds: Rect}>(target: Rect, displays: D[]): D | undefined {
    let best: D | undefined;
    let bestArea = -1;
    for (const d of displays) {
        const area = overlapArea(target, d.bounds);
        if (area > bestArea) {
            best = d;
            bestArea = area;
        }
    }
    return best;
}

/**
 * Native window id parsed out of a desktopCapturer id:
 * `window:<HWND | CGWindowID | X11 window id>:<n>` or `screen:<id>:<n>`.
 */
export function parseSourceId(sourceId: string): {kind: 'screen' | 'window'; nativeId: string} | undefined {
    const m = (/^(screen|window):(\d{1,20}):(\d{1,10})$/).exec(sourceId);
    return m ? {kind: m[1] as 'screen' | 'window', nativeId: m[2]} : undefined;
}
