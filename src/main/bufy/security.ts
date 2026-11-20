// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: decides whether an IPC call comes from a page we trust.
//
// Trusted = the main frame of a Mattermost server view (tab or popout) or of the Calls widget window,
// currently showing a page of the configured server origin. This is the same trust boundary the upstream
// `desktopAPI` relies on (the externalAPI preload is only attached to those views), made explicit here
// because bufy calls can change global OS state.

import type {IpcMainEvent, IpcMainInvokeEvent} from 'electron';

import CallsWidgetWindow from 'app/callsWidgetWindow';
import WebContentsManager from 'app/views/webContentsManager';
import ServerManager from 'common/servers/serverManager';
import {parseURL} from 'common/utils/url';

export type TrustedSender = {
    webContentsId: number;
    viewId?: string;
    serverId?: string;
    origin: string;
};

type FrameLike = {url: string; parent?: unknown | null} | null | undefined;
type SenderEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender'> & {senderFrame?: FrameLike};

export type TrustDeps = {
    getViewByWebContentsId: (id: number) => {id: string; serverId: string} | undefined;
    getServerURL: (serverId: string) => URL | undefined;
    isCallsWidget: (id: number) => boolean;
    getCallsWidgetURL: () => string | undefined;
};

const defaultDeps: TrustDeps = {
    getViewByWebContentsId: (id) => WebContentsManager.getViewByWebContentsId(id),
    getServerURL: (serverId) => ServerManager.getServer(serverId)?.url,
    isCallsWidget: (id) => CallsWidgetWindow.isCallsWidget(id),
    getCallsWidgetURL: () => CallsWidgetWindow.getViewURL()?.toString(),
};

export function resolveTrustedSender(event: SenderEvent, deps: TrustDeps = defaultDeps): TrustedSender | undefined {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) {
        return undefined;
    }

    const frame = event.senderFrame;
    if (!frame || frame.parent) {
        // sub-frames (iframes) never get access
        return undefined;
    }
    const frameURL = parseURL(frame.url);
    if (!frameURL || (frameURL.protocol !== 'https:' && frameURL.protocol !== 'http:')) {
        return undefined;
    }

    const view = deps.getViewByWebContentsId(sender.id);
    if (view) {
        const serverURL = deps.getServerURL(view.serverId);
        if (serverURL && serverURL.origin === frameURL.origin) {
            return {webContentsId: sender.id, viewId: view.id, serverId: view.serverId, origin: frameURL.origin};
        }
        return undefined;
    }

    if (deps.isCallsWidget(sender.id)) {
        const widgetURL = parseURL(deps.getCallsWidgetURL() ?? '');
        if (widgetURL && widgetURL.origin === frameURL.origin) {
            return {webContentsId: sender.id, origin: frameURL.origin};
        }
    }

    return undefined;
}
