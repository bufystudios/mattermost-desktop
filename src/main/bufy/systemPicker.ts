// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: screen sharing on Linux Wayland with exactly one system picker.
//
// On Wayland Chromium captures through the xdg-desktop-portal ScreenCast interface, and every capture session shows
// the compositor's picker. The usual desktop-app flow (`desktopCapturer.getSources()` for a thumbnail list, then
// `getUserMedia({chromeMediaSourceId})`) therefore opens one portal session for the list and a second one for the
// capture: the second is only silent when the user left "allow without asking next time" ticked (the portal then hands
// out a restore token for the source id). So on Wayland we let `navigator.mediaDevices.getDisplayMedia()` grant a
// placeholder source id that no list ever returned: WebRTC's PipeWire capturer has no restore token for it and opens
// one portal session, whose picker is the only one the user sees. See docs/bufy/wayland.md.

import type {DisplayMediaRequestHandlerHandlerRequest, Streams} from 'electron';

import {Logger} from 'common/log';

import {resolveTrustedSender} from './security';

const log = new Logger('Bufy.SystemPicker');

/**
 * Source id granted to getDisplayMedia on Wayland. WebRTC's PipeWire capturer uses a portal restore token only for a
 * selected source id other than 0, and stores the tokens it gets under the ids of the capturers that listed them, so
 * for 0 there is never one: every share asks the portal once, and the user can pick something else each time.
 * Measured on KDE Plasma 6.8: Chromium restarts the capture for every `applyConstraints` on such a track, and the
 * restart asks the portal again (no token), whatever the picker's "allow without asking" box says. A page must
 * therefore not reconfigure the track; it scales in the encoder instead (see `screenSharePicker` in shared.ts).
 */
export const SYSTEM_PICKER_SOURCE_ID = 'screen:0:0';

type FrameLike = {url: string; parent?: unknown | null; isDestroyed?: () => boolean};
type WebContentsLike = {id: number; isDestroyed: () => boolean};

export type SystemPickerDeps = {
    webContentsFromFrame: (frame: FrameLike) => WebContentsLike | undefined;
    isTrusted?: (sender: WebContentsLike, frame: FrameLike) => boolean;

    /** The app's own permission flow for `display-capture` (asks once per server origin, like the Calls screen share). */
    askPermission: (webContentsId: number, frameURL: string) => Promise<boolean>;
};

const defaultIsTrusted = (sender: WebContentsLike, frame: FrameLike) => Boolean(resolveTrustedSender({
    sender: sender as never,
    senderFrame: frame,
}));

/**
 * The `setDisplayMediaRequestHandler` handler used on Wayland. Grants the placeholder source to the main frame of a
 * trusted Mattermost server page (same boundary as the rest of the bufy API) that asked for video, after the app's
 * `display-capture` permission; refuses everything else. Never grants audio (Linux has no loopback capture).
 */
export function createSystemPickerHandler(deps: SystemPickerDeps) {
    const isTrusted = deps.isTrusted ?? defaultIsTrusted;
    return async (request: Pick<DisplayMediaRequestHandlerHandlerRequest, 'frame' | 'videoRequested'>, callback: (streams: Streams | null) => void) => {
        const deny = () => callback(null);
        try {
            const frame = request.frame as FrameLike | null;
            if (!request.videoRequested || !frame || frame.isDestroyed?.()) {
                deny();
                return;
            }
            const sender = deps.webContentsFromFrame(frame);
            if (!sender || sender.isDestroyed() || !isTrusted(sender, frame)) {
                log.warn('getDisplayMedia refused: untrusted requester');
                deny();
                return;
            }
            if (!await deps.askPermission(sender.id, frame.url)) {
                deny();
                return;
            }
            callback({video: {id: SYSTEM_PICKER_SOURCE_ID, name: ''}});
        } catch (err) {
            log.warn('getDisplayMedia handler failed', {err});
            deny();
        }
    };
}
