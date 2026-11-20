// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: converts our key names / Electron accelerators into the `preferred_trigger` strings of the
// xdg-desktop-portal GlobalShortcuts interface (https://specifications.freedesktop.org/shortcuts-spec/latest/):
// modifiers `CTRL`, `ALT`, `SHIFT`, `LOGO` joined with `+`, the key as an XKB keysym name (`a`, `space`, `F13`).
// The compositor is free to ignore the suggestion; the user decides in the system dialog.

import {modifierOfKey, parseKeyName} from './keys';
import type {ModifierName} from './shared';

// KeyboardEvent.code -> XKB keysym name, for everything that is not covered by a rule below.
const CODE_TO_KEYSYM: Readonly<Record<string, string>> = {
    Space: 'space',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'BackSpace',
    Escape: 'Escape',
    CapsLock: 'Caps_Lock',
    Insert: 'Insert',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'Page_Up',
    PageDown: 'Page_Down',
    ArrowLeft: 'Left',
    ArrowUp: 'Up',
    ArrowRight: 'Right',
    ArrowDown: 'Down',
    NumpadMultiply: 'KP_Multiply',
    NumpadAdd: 'KP_Add',
    NumpadSubtract: 'KP_Subtract',
    NumpadDecimal: 'KP_Decimal',
    NumpadDivide: 'KP_Divide',
    NumpadEnter: 'KP_Enter',
    Semicolon: 'semicolon',
    Equal: 'equal',
    Comma: 'comma',
    Minus: 'minus',
    Period: 'period',
    Slash: 'slash',
    Backquote: 'grave',
    BracketLeft: 'bracketleft',
    Backslash: 'backslash',
    BracketRight: 'bracketright',
    Quote: 'apostrophe',
    ControlLeft: 'Control_L',
    ControlRight: 'Control_R',
    AltLeft: 'Alt_L',
    AltRight: 'Alt_R',
    ShiftLeft: 'Shift_L',
    ShiftRight: 'Shift_R',
    MetaLeft: 'Super_L',
    MetaRight: 'Super_R',
    NumLock: 'Num_Lock',
    ScrollLock: 'Scroll_Lock',
    PrintScreen: 'Print',
};

const MODIFIER_TRIGGER: Readonly<Record<ModifierName, string>> = {
    ctrl: 'CTRL',
    alt: 'ALT',
    shift: 'SHIFT',
    meta: 'LOGO',
};

// Order used by the shortcuts spec examples.
const MODIFIER_ORDER: readonly ModifierName[] = ['ctrl', 'alt', 'shift', 'meta'];

function keysymForCode(code: string): string | undefined {
    const letter = (/^Key([A-Z])$/).exec(code);
    if (letter) {
        return letter[1].toLowerCase();
    }
    const digit = (/^Digit([0-9])$/).exec(code);
    if (digit) {
        return digit[1];
    }
    const numpad = (/^Numpad([0-9])$/).exec(code);
    if (numpad) {
        return `KP_${numpad[1]}`;
    }
    if ((/^F([1-9]|1[0-9]|2[0-4])$/).test(code)) {
        return code;
    }
    return CODE_TO_KEYSYM[code];
}

function joinTrigger(mods: Iterable<ModifierName>, keysym: string): string {
    const set = new Set(mods);
    return [...MODIFIER_ORDER.filter((m) => set.has(m)).map((m) => MODIFIER_TRIGGER[m]), keysym].join('+');
}

/**
 * Trigger suggestion for a push-to-talk key. `undefined` for keys the portal cannot express
 * (mouse buttons): the shortcut is then bound without a suggestion and the user picks one in the dialog.
 */
export function triggerForKey(keyName: string, modifiers: readonly ModifierName[] = []): string | undefined {
    const parsed = parseKeyName(keyName);
    if (!parsed || parsed.type !== 'keyboard') {
        return undefined;
    }
    const keysym = keysymForCode(parsed.name);
    if (!keysym) {
        return undefined;
    }

    // A lone modifier key is its own trigger; "Ctrl+Control_R" would never match.
    return joinTrigger(modifierOfKey(parsed.name) ? [] : modifiers, keysym);
}

const ACCEL_MODIFIERS: Readonly<Record<string, ModifierName>> = {
    command: 'ctrl',
    cmd: 'ctrl',
    control: 'ctrl',
    ctrl: 'ctrl',
    commandorcontrol: 'ctrl',
    cmdorctrl: 'ctrl',
    alt: 'alt',
    option: 'alt',
    altgr: 'alt',
    shift: 'shift',
    super: 'meta',
    meta: 'meta',
};

const ACCEL_KEYS: Readonly<Record<string, string>> = {
    plus: 'plus',
    space: 'space',
    tab: 'Tab',
    capslock: 'Caps_Lock',
    numlock: 'Num_Lock',
    scrolllock: 'Scroll_Lock',
    backspace: 'BackSpace',
    delete: 'Delete',
    insert: 'Insert',
    return: 'Return',
    enter: 'Return',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'Page_Up',
    pagedown: 'Page_Down',
    escape: 'Escape',
    esc: 'Escape',
    volumeup: 'XF86AudioRaiseVolume',
    volumedown: 'XF86AudioLowerVolume',
    volumemute: 'XF86AudioMute',
    medianexttrack: 'XF86AudioNext',
    mediaprevioustrack: 'XF86AudioPrev',
    mediastop: 'XF86AudioStop',
    mediaplaypause: 'XF86AudioPlay',
    printscreen: 'Print',
    numdec: 'KP_Decimal',
    numadd: 'KP_Add',
    numsub: 'KP_Subtract',
    nummult: 'KP_Multiply',
    numdiv: 'KP_Divide',
    '`': 'grave',
    '-': 'minus',
    '=': 'equal',
    '[': 'bracketleft',
    ']': 'bracketright',
    ';': 'semicolon',
    '\'': 'apostrophe',
    ',': 'comma',
    '.': 'period',
    '/': 'slash',
};

/** Trigger suggestion for an (already validated) Electron accelerator such as `CommandOrControl+Shift+M`. */
export function triggerForAccelerator(accelerator: string): string | undefined {
    const parts = accelerator.split('+');
    const key = parts[parts.length - 1];
    const mods: ModifierName[] = [];
    for (const m of parts.slice(0, -1)) {
        const mapped = ACCEL_MODIFIERS[m.toLowerCase()];
        if (!mapped) {
            return undefined;
        }
        mods.push(mapped);
    }

    let keysym: string | undefined;
    if ((/^[A-Za-z]$/).test(key)) {
        keysym = key.toLowerCase();
    } else if ((/^[0-9]$/).test(key)) {
        keysym = key;
    } else if ((/^F([1-9]|1[0-9]|2[0-4])$/i).test(key)) {
        keysym = key.toUpperCase();
    } else if ((/^num[0-9]$/i).test(key)) {
        keysym = `KP_${key.slice(3)}`;
    } else {
        keysym = ACCEL_KEYS[key.toLowerCase()];
    }
    return keysym ? joinTrigger(mods, keysym) : undefined;
}
