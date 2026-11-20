// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: key name <-> libuiohook virtual keycode tables.
//
// Public key names follow `KeyboardEvent.code` so plugins can pass `event.code` straight through.
// The numeric values are libuiohook's VC_* codes (what `uiohook-napi` reports as `keycode`).

import type {ModifierName} from './shared';

export const KEYBOARD_CODES: Readonly<Record<string, number>> = {
    KeyA: 30,
    KeyB: 48,
    KeyC: 46,
    KeyD: 32,
    KeyE: 18,
    KeyF: 33,
    KeyG: 34,
    KeyH: 35,
    KeyI: 23,
    KeyJ: 36,
    KeyK: 37,
    KeyL: 38,
    KeyM: 50,
    KeyN: 49,
    KeyO: 24,
    KeyP: 25,
    KeyQ: 16,
    KeyR: 19,
    KeyS: 31,
    KeyT: 20,
    KeyU: 22,
    KeyV: 47,
    KeyW: 17,
    KeyX: 45,
    KeyY: 21,
    KeyZ: 44,
    Digit0: 11,
    Numpad0: 82,
    Digit1: 2,
    Numpad1: 79,
    Digit2: 3,
    Numpad2: 80,
    Digit3: 4,
    Numpad3: 81,
    Digit4: 5,
    Numpad4: 75,
    Digit5: 6,
    Numpad5: 76,
    Digit6: 7,
    Numpad6: 77,
    Digit7: 8,
    Numpad7: 71,
    Digit8: 9,
    Numpad8: 72,
    Digit9: 10,
    Numpad9: 73,
    F1: 59,
    F2: 60,
    F3: 61,
    F4: 62,
    F5: 63,
    F6: 64,
    F7: 65,
    F8: 66,
    F9: 67,
    F10: 68,
    F11: 87,
    F12: 88,
    F13: 91,
    F14: 92,
    F15: 93,
    F16: 99,
    F17: 100,
    F18: 101,
    F19: 102,
    F20: 103,
    F21: 104,
    F22: 105,
    F23: 106,
    F24: 107,
    Space: 57,
    Enter: 28,
    Tab: 15,
    Backspace: 14,
    Escape: 1,
    CapsLock: 58,
    Insert: 3666,
    Delete: 3667,
    Home: 3655,
    End: 3663,
    PageUp: 3657,
    PageDown: 3665,
    ArrowLeft: 57419,
    ArrowUp: 57416,
    ArrowRight: 57421,
    ArrowDown: 57424,
    NumpadMultiply: 55,
    NumpadAdd: 78,
    NumpadSubtract: 74,
    NumpadDecimal: 83,
    NumpadDivide: 3637,
    NumpadEnter: 3612,
    Semicolon: 39,
    Equal: 13,
    Comma: 51,
    Minus: 12,
    Period: 52,
    Slash: 53,
    Backquote: 41,
    BracketLeft: 26,
    Backslash: 43,
    BracketRight: 27,
    Quote: 40,
    ControlLeft: 29,
    ControlRight: 3613,
    AltLeft: 56,
    AltRight: 3640,
    ShiftLeft: 42,
    ShiftRight: 54,
    MetaLeft: 3675,
    MetaRight: 3676,
    NumLock: 69,
    ScrollLock: 70,
    PrintScreen: 3639,
};

const REVERSE = new Map<number, string>();
for (const [code, keycode] of Object.entries(KEYBOARD_CODES)) {
    if (!REVERSE.has(keycode)) {
        REVERSE.set(keycode, code);
    }
}

// libuiohook mouse button numbers. Left/right are deliberately not bindable.
const MOUSE_BUTTONS: Readonly<Record<string, number>> = {
    Mouse3: 3,
    Mouse4: 4,
    Mouse5: 5,
};
const MOUSE_ALIASES: Readonly<Record<string, string>> = {
    MouseMiddle: 'Mouse3',
    MouseBack: 'Mouse4',
    MouseForward: 'Mouse5',
};
const MOUSE_REVERSE = new Map<number, string>(Object.entries(MOUSE_BUTTONS).map(([name, n]) => [n, name]));

const MODIFIER_KEYS: Readonly<Record<string, ModifierName>> = {
    ControlLeft: 'ctrl',
    ControlRight: 'ctrl',
    AltLeft: 'alt',
    AltRight: 'alt',
    ShiftLeft: 'shift',
    ShiftRight: 'shift',
    MetaLeft: 'meta',
    MetaRight: 'meta',
};

export const MODIFIER_NAMES: readonly ModifierName[] = ['ctrl', 'alt', 'shift', 'meta'];

export type ParsedKey =
    | {type: 'keyboard'; name: string; keycode: number}
    | {type: 'mouse'; name: string; button: number};

/** Parses a public key name; returns undefined when it is not bindable. */
export function parseKeyName(input: string): ParsedKey | undefined {
    const name = MOUSE_ALIASES[input] ?? input;
    if (Object.prototype.hasOwnProperty.call(MOUSE_BUTTONS, name)) {
        return {type: 'mouse', name, button: MOUSE_BUTTONS[name]};
    }
    if (Object.prototype.hasOwnProperty.call(KEYBOARD_CODES, name)) {
        return {type: 'keyboard', name, keycode: KEYBOARD_CODES[name]};
    }
    return undefined;
}

export function keyNameFromKeycode(keycode: number): string | undefined {
    return REVERSE.get(keycode);
}

export function mouseNameFromButton(button: unknown): string | undefined {
    return typeof button === 'number' ? MOUSE_REVERSE.get(button) : undefined;
}

/** `ctrl` for ControlLeft/ControlRight etc., undefined for everything else. */
export function modifierOfKey(name: string): ModifierName | undefined {
    return MODIFIER_KEYS[name];
}

export function normalizeModifiers(mods: readonly ModifierName[] | undefined): ModifierName[] {
    const set = new Set(mods ?? []);
    return MODIFIER_NAMES.filter((m) => set.has(m));
}

export function modifiersFromEvent(e: {ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean}): ModifierName[] {
    const out: ModifierName[] = [];
    if (e.ctrlKey) {
        out.push('ctrl');
    }
    if (e.altKey) {
        out.push('alt');
    }
    if (e.shiftKey) {
        out.push('shift');
    }
    if (e.metaKey) {
        out.push('meta');
    }
    return out;
}
