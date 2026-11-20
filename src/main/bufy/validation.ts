// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: input validation for everything that arrives from a web page.

import Joi from 'joi';

import {LIMITS} from './shared';
import type {BufyFailure} from './shared';

export const sourceIdSchema = Joi.string().pattern(/^(screen|window):\d{1,20}:\d{1,10}$/);

// Named CSS colors are intentionally not accepted: hex or rgb()/rgba() only.
const colorSchema = Joi.string().max(40).pattern(/^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/);

export const shareBorderSchema = Joi.object({
    sourceId: sourceIdSchema.required(),
    color: colorSchema,
    thickness: Joi.number().integer().min(1).max(12),
}).required();

export const pushToTalkSchema = Joi.object({
    key: Joi.string().max(32).required(),
    modifiers: Joi.array().items(Joi.string().valid('ctrl', 'alt', 'shift', 'meta')).max(4).unique(),
}).required();

export const captureSchema = Joi.object({
    timeoutMs: Joi.number().integer().min(500).max(LIMITS.captureMaxTimeoutMs),
});

export const shortcutIdSchema = Joi.string().pattern(/^[A-Za-z0-9_.:-]{1,64}$/).required();

export const shortcutSchema = Joi.object({
    id: shortcutIdSchema,
    accelerator: Joi.string().max(64).required(),
}).required();

const labelSchema = Joi.string().max(LIMITS.maxLabelLength).allow('');
export const voiceStatusSchema = Joi.object({
    connected: Joi.boolean().required(),
    muted: Joi.boolean(),
    deafened: Joi.boolean(),
    live: Joi.boolean(),
    roomName: Joi.string().max(LIMITS.maxRoomNameLength).allow(''),
    labels: Joi.object({
        mute: labelSchema,
        unmute: labelSchema,
        deafen: labelSchema,
        undeafen: labelSchema,
        stopSharing: labelSchema,
        leave: labelSchema,
    }),
}).required();

/** Validates a single value; returns the (stripped) value or a failure result. */
export function validateArg<T>(schema: Joi.Schema, value: unknown): {value: T} | BufyFailure {
    const {error, value: out} = schema.validate(value, {stripUnknown: true});
    if (error) {
        return {ok: false, error: 'invalid-argument', message: error.message};
    }
    return {value: out as T};
}

export function isFailure(x: unknown): x is BufyFailure {
    return typeof x === 'object' && x !== null && (x as {ok?: unknown}).ok === false;
}

// ---- Electron accelerator validation (globalShortcut) ----

const ACCEL_MODIFIERS = new Set([
    'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);
const ACCEL_KEY_RE = /^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Capslock|Numlock|Scrolllock|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause|PrintScreen|num[0-9]|numdec|numadd|numsub|nummult|numdiv|[`\-=[\];',./])$/;
const CTRL_LIKE = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'super', 'meta']);
const FREESTANDING_OK = /^(F([1-9]|1[0-9]|2[0-4])|Volume(Up|Down|Mute)|Media(NextTrack|PreviousTrack|Stop|PlayPause)|PrintScreen)$/;

// Editing / window management combos a page must not be able to steal system-wide.
const RESERVED_COMBOS = new Set([
    'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+a', 'ctrl+z', 'ctrl+y', 'ctrl+s', 'ctrl+w', 'ctrl+q', 'ctrl+tab',
    'alt+f4', 'alt+tab', 'alt+ctrl+delete', 'ctrl+shift+escape', 'ctrl+shift+esc', 'super+l', 'super+d', 'super+tab',
]);

export type AcceleratorCheck = {ok: true; normalized: string} | {ok: false; message: string};

/**
 * Accepts Electron accelerators with sane safety rules:
 * - a plain key (no Ctrl/Alt/Cmd/Super) is only allowed for F-keys and media keys, otherwise the
 *   shortcut would swallow normal typing system-wide;
 * - well-known editing and window-manager combos are rejected.
 */
export function checkAccelerator(accelerator: string): AcceleratorCheck {
    const parts = accelerator.split('+');
    if (accelerator.endsWith('++')) {
        // "Ctrl++" style: the key is "+" which Electron spells "Plus"
        return {ok: false, message: 'Use "Plus" for the plus key'};
    }
    if (parts.some((p) => p.length === 0)) {
        return {ok: false, message: 'Malformed accelerator'};
    }
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
    if (!ACCEL_KEY_RE.test(key)) {
        return {ok: false, message: `Unsupported key "${key}"`};
    }
    if (mods.some((m) => !ACCEL_MODIFIERS.has(m))) {
        return {ok: false, message: 'Unknown modifier'};
    }
    if (new Set(mods).size !== mods.length) {
        return {ok: false, message: 'Duplicate modifier'};
    }
    const hasCtrlLike = mods.some((m) => CTRL_LIKE.has(m));
    if (!hasCtrlLike && !FREESTANDING_OK.test(key)) {
        return {ok: false, message: 'Shortcut needs Ctrl/Alt/Cmd/Super (only F-keys and media keys may be used alone)'};
    }
    const canon = [...new Set(mods.map(canonMod))].sort().concat(key.toLowerCase()).join('+');
    if (RESERVED_COMBOS.has(canon)) {
        return {ok: false, message: 'Reserved system shortcut'};
    }
    return {ok: true, normalized: [...mods.map((m, i) => parts[i] ?? m), key].join('+')};
}

function canonMod(m: string) {
    switch (m) {
    case 'command':
    case 'cmd':
    case 'control':
    case 'commandorcontrol':
    case 'cmdorctrl':
        return 'ctrl';
    case 'option':
    case 'altgr':
        return 'alt';
    case 'meta':
        return 'super';
    default:
        return m;
    }
}

/** Case-insensitive identity of an accelerator, used to detect duplicates between views. */
export function acceleratorIdentity(accelerator: string): string {
    const parts = accelerator.split('+');
    const key = parts[parts.length - 1].toLowerCase();
    return [...new Set(parts.slice(0, -1).map((m) => canonMod(m.toLowerCase())))].sort().concat(key).join('+');
}
