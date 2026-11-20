// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: screen-share border controller. Resolves a desktopCapturer id to a display or window,
// shows one frame window, and keeps it glued to the shared window by polling its native bounds.

import {Logger} from 'common/log';

import {displayForRect, isUsableRect, parseSourceId, rectsEqual, roundRect} from './geometry';
import type {Rect} from './geometry';
import type {OverlayStyle, OverlayWindowLike} from './overlayWindow';
import type {ShareBorderResult} from './shared';
import type {WindowBoundsProvider} from './windowBounds';

const log = new Logger('Bufy.Overlay');

export const OVERLAY_POLL_MS = 120;
const MAX_CONSECUTIVE_ERRORS = 5;

export type DisplayLike = {id: number; bounds: Rect};
export type SourceLike = {id: string; name?: string; display_id?: string};

export type OverlayDeps = {
    getSources: () => Promise<SourceLike[]>;
    getAllDisplays: () => DisplayLike[];
    getPrimaryDisplay: () => DisplayLike;
    createWindow: (bounds: Rect, style: OverlayStyle) => OverlayWindowLike;
    boundsProvider?: WindowBoundsProvider;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
};

type Active = {
    ownerId: number;
    win: OverlayWindowLike;
    timer?: NodeJS.Timeout;
    nativeWindowId?: string;
    errors: number;
    last?: Rect;
    target: 'window' | 'display';
};

export class ShareBorder {
    private active?: Active;
    private seq = 0;
    private pendingOwner?: number;

    private deps: OverlayDeps;
    private onLost: (ownerId: number) => void;

    constructor(deps: OverlayDeps, onLost: (ownerId: number) => void) {
        this.deps = deps;
        this.onLost = onLost;
    }

    get isShowing() {
        return Boolean(this.active);
    }

    get ownerId() {
        return this.active?.ownerId;
    }

    show = async (ownerId: number, sourceId: string, style: OverlayStyle): Promise<ShareBorderResult> => {
        const parsed = parseSourceId(sourceId);
        if (!parsed) {
            return {ok: false, error: 'invalid-argument', message: 'Malformed sourceId'};
        }

        // A newer call supersedes an in-flight older one.
        const mySeq = ++this.seq;
        this.pendingOwner = ownerId;

        let sources: SourceLike[];
        try {
            sources = await this.deps.getSources();
        } catch (err) {
            log.warn('desktopCapturer.getSources failed', {err});
            return {ok: false, error: 'internal-error', message: 'Could not enumerate capture sources'};
        }
        if (mySeq !== this.seq) {
            return {ok: false, error: 'cancelled'};
        }

        const source = sources.find((s) => s.id === sourceId);
        if (!source) {
            return {ok: false, error: 'source-not-found'};
        }

        const displays = this.deps.getAllDisplays();
        let initial: Rect | undefined;
        let target: 'window' | 'display' = 'display';
        let nativeWindowId: string | undefined;

        if (parsed.kind === 'screen') {
            const display = displays.find((d) => String(d.id) === source.display_id) ?? this.matchDisplayById(displays, parsed.nativeId);
            if (!display) {
                return {ok: false, error: 'source-not-found', message: 'Display for source not found'};
            }
            initial = display.bounds;
        } else {
            const res = this.deps.boundsProvider?.getBounds(parsed.nativeId);
            if (res?.state === 'ok' && isUsableRect(res.bounds)) {
                initial = roundRect(res.bounds);
                target = 'window';
                nativeWindowId = parsed.nativeId;
            } else if (res?.state === 'gone') {
                return {ok: false, error: 'source-not-found', message: 'Window no longer exists'};
            } else {
                // Bounds cannot be read here (Wayland, FFI failure, minimized at start...): frame a display instead.
                initial = this.deps.getPrimaryDisplay().bounds;
            }
        }

        this.hide();
        const win = this.deps.createWindow(initial, style);
        const active: Active = {ownerId, win, nativeWindowId, errors: 0, last: initial, target};
        this.active = active;
        win.showInactive();

        if (nativeWindowId) {
            const setI = this.deps.setInterval ?? setInterval;
            active.timer = setI(() => this.tick(active), OVERLAY_POLL_MS);
        }
        return {ok: true, target};
    };

    hide = () => {
        const a = this.active;
        if (!a) {
            return;
        }
        this.active = undefined;
        const clearI = this.deps.clearInterval ?? clearInterval;
        if (a.timer) {
            clearI(a.timer);
        }
        a.win.destroy();
    };

    /** Hides the border when it belongs to `ownerId`. */
    releaseOwner = (ownerId: number) => {
        if (this.pendingOwner === ownerId) {
            // a show() of this owner is still resolving its sources: make it a no-op ("stop" must win over "start")
            this.seq++;
        }
        if (this.active?.ownerId === ownerId) {
            this.hide();
        }
    };

    dispose = () => {
        this.seq++;
        this.hide();
    };

    // exposed for tests
    tick = (a: Active) => {
        if (this.active !== a || a.win.isDestroyed() || !a.nativeWindowId || !this.deps.boundsProvider) {
            return;
        }
        const res = this.deps.boundsProvider.getBounds(a.nativeWindowId);
        switch (res.state) {
        case 'ok': {
            a.errors = 0;
            const next = roundRect(res.bounds);
            if (!isUsableRect(next)) {
                return;
            }
            if (!rectsEqual(a.last, next)) {
                a.win.setBounds(next);
                a.last = next;
            }
            if (!a.win.isVisible()) {
                a.win.showInactive();
            }
            break;
        }
        case 'minimized':
            a.errors = 0;
            if (a.win.isVisible()) {
                a.win.hide();
            }
            break;
        case 'gone': {
            const ownerId = a.ownerId;
            this.hide();
            this.onLost(ownerId);
            break;
        }
        default:
            if (++a.errors >= MAX_CONSECUTIVE_ERRORS) {
                // Reading bounds keeps failing: stop following and frame the display the window was last on.
                const display = displayForRect(a.last ?? this.deps.getPrimaryDisplay().bounds, this.deps.getAllDisplays()) ?? this.deps.getPrimaryDisplay();
                const clearI = this.deps.clearInterval ?? clearInterval;
                if (a.timer) {
                    clearI(a.timer);
                    a.timer = undefined;
                }
                a.nativeWindowId = undefined;
                a.target = 'display';
                a.last = display.bounds;
                a.win.setBounds(display.bounds);
                a.win.showInactive();
                log.warn('window bounds unreadable, falling back to display framing');
            }
        }
    };

    get current() {
        return this.active;
    }

    private matchDisplayById = (displays: DisplayLike[], nativeId: string) => {
        // Last resort when desktopCapturer gave no display_id: some platforms encode the display id in the source id.
        return displays.find((d) => String(d.id) === nativeId);
    };
}
