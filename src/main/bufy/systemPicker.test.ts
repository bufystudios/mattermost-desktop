// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {createSystemPickerHandler, SYSTEM_PICKER_SOURCE_ID} from './systemPicker';

jest.mock('./security', () => ({resolveTrustedSender: jest.fn()}));

const mainFrame = {url: 'https://chat.example.com/team/channels/town', parent: null, isDestroyed: () => false};
const page = {id: 7, isDestroyed: () => false};

function setup(overrides: {trusted?: boolean; allowed?: boolean; sender?: typeof page | undefined} = {}) {
    const askPermission = jest.fn().mockResolvedValue(overrides.allowed ?? true);
    const isTrusted = jest.fn().mockReturnValue(overrides.trusted ?? true);
    const handler = createSystemPickerHandler({
        webContentsFromFrame: () => ('sender' in overrides ? overrides.sender : page),
        isTrusted,
        askPermission,
    });
    const callback = jest.fn();
    return {handler, callback, askPermission, isTrusted};
}

describe('bufy/systemPicker', () => {
    it('grants the placeholder source (no audio) to a trusted page after the permission', async () => {
        const {handler, callback, askPermission, isTrusted} = setup();
        await handler({frame: mainFrame as never, videoRequested: true}, callback);
        expect(isTrusted).toHaveBeenCalledWith(page, mainFrame);
        expect(askPermission).toHaveBeenCalledWith(7, mainFrame.url);
        expect(callback).toHaveBeenCalledWith({video: {id: SYSTEM_PICKER_SOURCE_ID, name: ''}});
    });

    it('grants source 0, for which WebRTC never uses a restore token: every share asks the portal exactly once', () => {
        expect(SYSTEM_PICKER_SOURCE_ID).toBe('screen:0:0');
    });

    it.each([
        ['an untrusted page', {trusted: false}, {frame: mainFrame, videoRequested: true}],
        ['a frame without a webContents', {sender: undefined}, {frame: mainFrame, videoRequested: true}],
        ['a denied permission', {allowed: false}, {frame: mainFrame, videoRequested: true}],
        ['an audio-only request', {}, {frame: mainFrame, videoRequested: false}],
        ['a destroyed frame', {}, {frame: {...mainFrame, isDestroyed: () => true}, videoRequested: true}],
        ['no frame', {}, {frame: null, videoRequested: true}],
    ])('refuses %s', async (_, overrides, request) => {
        const {handler, callback} = setup(overrides);
        await handler(request as never, callback);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(null);
    });

    it('refuses instead of throwing when the permission flow fails', async () => {
        const {handler, callback, askPermission} = setup();
        askPermission.mockRejectedValue(new Error('boom'));
        await handler({frame: mainFrame as never, videoRequested: true}, callback);
        expect(callback).toHaveBeenCalledWith(null);
    });
});
