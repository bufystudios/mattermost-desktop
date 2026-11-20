// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: voice status on the existing tray icon (colored badge variant, tooltip and extra menu items).
// Upstream's TrayIcon and createTrayMenu call into this module through two tiny hooks (see docs/bufy/README.md);
// everything else lives here. No second tray icon is created.

import type {MenuItemConstructorOptions, NativeImage} from 'electron';
import {app, nativeImage} from 'electron';

import {LIMITS} from './shared';
import type {BufyResult, TrayAction, TrayLabelKey, VoiceStatus} from './shared';

export type BadgeVariant = 'connected' | 'muted' | 'deafened' | 'live';

const BADGE_COLORS: Record<BadgeVariant, [number, number, number]> = {
    connected: [46, 184, 92], // green
    muted: [245, 158, 11], // amber
    deafened: [200, 40, 40], // dark red
    live: [229, 37, 42], // red
};

const DEFAULT_LABELS: Record<TrayLabelKey, string> = {
    mute: 'Mute',
    unmute: 'Unmute',
    deafen: 'Deafen',
    undeafen: 'Undeafen',
    stopSharing: 'Stop sharing',
    leave: 'Leave voice',
};

const BADGE_SIZE = 32;

export function pickVariant(s: Pick<VoiceStatus, 'muted' | 'deafened' | 'live'>): BadgeVariant {
    if (s.deafened) {
        return 'deafened';
    }
    if (s.live) {
        return 'live';
    }
    if (s.muted) {
        return 'muted';
    }
    return 'connected';
}

export function buildTooltip(baseName: string, s: VoiceStatus): string {
    const flags = [s.live ? 'live' : '', s.deafened ? 'deafened' : '', s.muted ? 'muted' : ''].filter(Boolean);
    const room = s.roomName ? ` - ${s.roomName}` : '';
    return `${baseName}${room}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

/** Paints an anti-aliased filled circle with a white ring into a BGRA bitmap (bottom-right corner). Pure, in place. */
export function paintBadge(bgra: Buffer, size: number, [r, g, b]: [number, number, number]) {
    const radius = size * 0.28;
    const cx = size - radius - 1;
    const cy = size - radius - 1;
    const ring = Math.max(1.5, size * 0.06);
    const inner = radius - 0.5;
    const outer = (radius + ring) - 0.5;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot((x + 0.5) - cx, (y + 0.5) - cy);
            let cover = 0;
            let rgb: [number, number, number] = [r, g, b];
            if (d <= inner) {
                cover = 1;
            } else if (d <= outer) {
                cover = 1;
                rgb = [255, 255, 255];
            } else if (d < outer + 1) {
                cover = (outer + 1) - d;
                rgb = [255, 255, 255];
            }
            if (cover > 0) {
                const i = ((y * size) + x) * 4;
                const keep = (bgra[i + 3] / 255) * (1 - cover);
                const outA = cover + keep;
                bgra[i] = Math.round(((rgb[2] * cover) + (bgra[i] * keep)) / outA);
                bgra[i + 1] = Math.round(((rgb[1] * cover) + (bgra[i + 1] * keep)) / outA);
                bgra[i + 2] = Math.round(((rgb[0] * cover) + (bgra[i + 2] * keep)) / outA);
                bgra[i + 3] = Math.round(outA * 255);
            }
        }
    }
}

type State = {ownerId: number; status: VoiceStatus};

let state: State | undefined;
const badgeCache = new WeakMap<NativeImage, Map<BadgeVariant, NativeImage>>();
let onAction: (ownerId: number, action: TrayAction) => void = () => {};
let refresh: () => void = () => {};

export function configureTrayStatus(opts: {onAction: (ownerId: number, action: TrayAction) => void; refresh: () => void}) {
    onAction = opts.onAction;
    refresh = opts.refresh;
}

export function setTrayVoiceStatus(ownerId: number, status: VoiceStatus): BufyResult {
    if (status.connected) {
        state = {ownerId, status};
        refresh();
    } else {
        // "disconnected" only clears the status that this same view set (another page cannot wipe it)
        clearTrayVoiceStatus(ownerId);
    }
    return {ok: true};
}

export function clearTrayVoiceStatus(ownerId?: number) {
    if (state && (ownerId === undefined || state.ownerId === ownerId)) {
        state = undefined;
        refresh();
    }
}

export function getTrayVoiceStatus() {
    return state;
}

/** Hook for TrayIcon.update(): returns the badged variant of `base`, or `base` itself when no voice session is active. */
export function applyVoiceBadge(base: NativeImage | undefined): NativeImage | undefined {
    if (!state || !base || base.isEmpty()) {
        return base;
    }
    const variant = pickVariant(state.status);
    let perVariant = badgeCache.get(base);
    if (!perVariant) {
        perVariant = new Map();
        badgeCache.set(base, perVariant);
    }
    let img = perVariant.get(variant);
    if (!img) {
        const resized = base.resize({width: BADGE_SIZE, height: BADGE_SIZE, quality: 'best'});
        const bitmap = Buffer.from(resized.toBitmap());
        paintBadge(bitmap, BADGE_SIZE, BADGE_COLORS[variant]);

        // 32 physical px at scale factor 2 = a 16 DIP tray icon on every platform
        img = nativeImage.createFromBitmap(bitmap, {width: BADGE_SIZE, height: BADGE_SIZE, scaleFactor: 2});
        perVariant.set(variant, img);
    }
    return img;
}

/** Hook for TrayIcon.update(): tooltip with the room name and mute/deafen/live flags while connected. */
export function applyVoiceTooltip(baseTooltip: string): string {
    return state ? buildTooltip(baseTooltip || app.name, state.status) : baseTooltip;
}

/** Hook for createTrayMenu(): extra items shown above the regular tray menu while connected. */
export function getVoiceTrayMenuTemplate(): MenuItemConstructorOptions[] {
    if (!state) {
        return [];
    }
    const {ownerId, status} = state;
    const label = (k: TrayLabelKey) => (status.labels?.[k] || DEFAULT_LABELS[k]).slice(0, LIMITS.maxLabelLength);
    const items: MenuItemConstructorOptions[] = [
        {label: status.roomName || 'Voice', enabled: false},
        {label: status.muted ? label('unmute') : label('mute'), click: () => onAction(ownerId, 'toggleMute')},
        {label: status.deafened ? label('undeafen') : label('deafen'), click: () => onAction(ownerId, 'toggleDeafen')},
    ];
    if (status.live) {
        items.push({label: label('stopSharing'), click: () => onAction(ownerId, 'stopSharing')});
    }
    items.push({label: label('leave'), click: () => onAction(ownerId, 'leave')}, {type: 'separator'});
    return items;
}
