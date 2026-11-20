// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {
    applyVoiceBadge,
    applyVoiceTooltip,
    buildTooltip,
    clearTrayVoiceStatus,
    configureTrayStatus,
    getTrayVoiceStatus,
    getVoiceTrayMenuTemplate,
    paintBadge,
    pickVariant,
    setTrayVoiceStatus,
} from './trayStatus';

jest.mock('electron', () => ({
    app: {name: 'Mattermost'},
    nativeImage: {createFromBitmap: jest.fn((buf: Buffer, o: {width: number; height: number}) => ({fromBitmap: true, size: o, buf}))},
}));

describe('bufy/trayStatus', () => {
    const onAction = jest.fn();
    const refresh = jest.fn();

    beforeEach(() => {
        clearTrayVoiceStatus();
        configureTrayStatus({onAction, refresh});
        onAction.mockClear();
        refresh.mockClear();
    });

    it('picks a badge variant with deafened > live > muted > connected priority', () => {
        expect(pickVariant({})).toBe('connected');
        expect(pickVariant({muted: true})).toBe('muted');
        expect(pickVariant({muted: true, live: true})).toBe('live');
        expect(pickVariant({muted: true, live: true, deafened: true})).toBe('deafened');
    });

    it('builds tooltips', () => {
        expect(buildTooltip('Mattermost', {connected: true})).toBe('Mattermost');
        expect(buildTooltip('Mattermost', {connected: true, roomName: 'Lobby', muted: true, live: true})).toBe('Mattermost - Lobby (live, muted)');
    });

    it('has no effect on tooltip/menu/image while no session is connected', () => {
        const base = {isEmpty: () => false};
        expect(applyVoiceTooltip('Mattermost')).toBe('Mattermost');
        expect(getVoiceTrayMenuTemplate()).toEqual([]);
        expect(applyVoiceBadge(base as never)).toBe(base);
    });

    it('tracks the owner and refreshes the tray on set/clear', () => {
        setTrayVoiceStatus(3, {connected: true, roomName: 'Lobby', muted: true});
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(getTrayVoiceStatus()?.ownerId).toBe(3);
        expect(applyVoiceTooltip('Mattermost')).toBe('Mattermost - Lobby (muted)');

        clearTrayVoiceStatus(4); // someone else's cleanup must not clear it
        expect(getTrayVoiceStatus()).toBeDefined();
        clearTrayVoiceStatus(3);
        expect(getTrayVoiceStatus()).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('connected:false clears the status of the same owner only', () => {
        setTrayVoiceStatus(3, {connected: true});
        setTrayVoiceStatus(4, {connected: false});
        expect(getTrayVoiceStatus()?.ownerId).toBe(3);
        setTrayVoiceStatus(3, {connected: false});
        expect(getTrayVoiceStatus()).toBeUndefined();
    });

    it('menu has Mute/Deafen/Leave and routes clicks back to the owner', () => {
        setTrayVoiceStatus(3, {connected: true, roomName: 'Lobby'});
        const items = getVoiceTrayMenuTemplate();
        const labels = items.map((i) => i.label ?? i.type);
        expect(labels).toEqual(['Lobby', 'Mute', 'Deafen', 'Leave voice', 'separator']);

        (items[1].click as () => void)();
        (items[2].click as () => void)();
        (items[3].click as () => void)();
        expect(onAction.mock.calls).toEqual([[3, 'toggleMute'], [3, 'toggleDeafen'], [3, 'leave']]);
    });

    it('menu reflects state: Unmute/Undeafen and a Stop sharing item only while live', () => {
        setTrayVoiceStatus(3, {connected: true, muted: true, deafened: true, live: true});
        const items = getVoiceTrayMenuTemplate();
        expect(items.map((i) => i.label ?? i.type)).toEqual(['Voice', 'Unmute', 'Undeafen', 'Stop sharing', 'Leave voice', 'separator']);
        (items[3].click as () => void)();
        expect(onAction).toHaveBeenCalledWith(3, 'stopSharing');
    });

    it('uses plugin supplied labels, truncated', () => {
        setTrayVoiceStatus(3, {connected: true, labels: {mute: 'Sustur', leave: 'x'.repeat(60)}});
        const items = getVoiceTrayMenuTemplate();
        expect(items[1].label).toBe('Sustur');
        expect(items[3].label).toHaveLength(40);
    });

    it('paints a colored badge into the bottom-right corner only', () => {
        const size = 32;
        const buf = Buffer.alloc(size * size * 4, 0); // fully transparent
        paintBadge(buf, size, [46, 184, 92]);
        const px = (x: number, y: number) => {
            const i = ((y * size) + x) * 4;
            return {b: buf[i], g: buf[i + 1], r: buf[i + 2], a: buf[i + 3]};
        };
        expect(px(0, 0).a).toBe(0);
        expect(px(size - 10, size - 10)).toEqual({r: 46, g: 184, b: 92, a: 255}); // BGRA -> green dot center
        expect(px(size - 1, size - 1).a).toBeLessThan(255);
    });
});
