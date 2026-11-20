// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {resolveTrustedSender} from './security';
import type {TrustDeps} from './security';

jest.mock('app/callsWidgetWindow', () => ({__esModule: true, default: {}}));
jest.mock('app/views/webContentsManager', () => ({__esModule: true, default: {}}));
jest.mock('common/servers/serverManager', () => ({__esModule: true, default: {}}));

const SERVER = new URL('https://chat.example.com/');

function deps(over: Partial<TrustDeps> = {}): TrustDeps {
    return {
        getViewByWebContentsId: (id) => (id === 10 ? {id: 'view-1', serverId: 'srv-1'} : undefined),
        getServerURL: (serverId) => (serverId === 'srv-1' ? SERVER : undefined),
        isCallsWidget: (id) => id === 20,
        getCallsWidgetURL: () => 'https://chat.example.com/subpath/',
        ...over,
    };
}

const event = (id: number, url: string | null, parent: unknown = null, destroyed = false) => ({
    sender: {id, isDestroyed: () => destroyed},
    senderFrame: url === null ? null : {url, parent},
}) as never;

describe('bufy/security resolveTrustedSender', () => {
    it('trusts the main frame of a server view on the configured origin', () => {
        expect(resolveTrustedSender(event(10, 'https://chat.example.com/team/channels/town-square'), deps())).toEqual({
            webContentsId: 10,
            viewId: 'view-1',
            serverId: 'srv-1',
            origin: 'https://chat.example.com',
        });
    });

    it('trusts the Calls widget window on the server origin', () => {
        expect(resolveTrustedSender(event(20, 'https://chat.example.com/plugins/com.mattermost.calls/standalone/widget.html'), deps())).toMatchObject({webContentsId: 20, origin: 'https://chat.example.com'});
    });

    it('rejects a view that navigated to another origin', () => {
        expect(resolveTrustedSender(event(10, 'https://evil.example.org/'), deps())).toBeUndefined();
        expect(resolveTrustedSender(event(10, 'http://chat.example.com/'), deps())).toBeUndefined(); // scheme differs
        expect(resolveTrustedSender(event(10, 'https://chat.example.com.evil.org/'), deps())).toBeUndefined();
        expect(resolveTrustedSender(event(10, 'https://chat.example.com:8443/'), deps())).toBeUndefined(); // port differs
    });

    it('rejects sub-frames (iframes) even on the right origin', () => {
        expect(resolveTrustedSender(event(10, 'https://chat.example.com/', {url: 'parent'}), deps())).toBeUndefined();
    });

    it('rejects unknown webContents, internal pages, missing frames and destroyed senders', () => {
        expect(resolveTrustedSender(event(99, 'https://chat.example.com/'), deps())).toBeUndefined();
        expect(resolveTrustedSender(event(10, 'mattermost-desktop://renderer/index.html'), deps())).toBeUndefined();
        expect(resolveTrustedSender(event(10, 'file:///etc/passwd'), deps())).toBeUndefined();
        expect(resolveTrustedSender(event(10, null), deps())).toBeUndefined();
        expect(resolveTrustedSender(event(10, 'not a url'), deps())).toBeUndefined();
        expect(resolveTrustedSender(event(10, 'https://chat.example.com/', null, true), deps())).toBeUndefined();
    });

    it('rejects views whose server no longer exists', () => {
        expect(resolveTrustedSender(event(10, 'https://chat.example.com/'), deps({getServerURL: () => undefined}))).toBeUndefined();
    });

    it('rejects the Calls widget when no call is active or origin differs', () => {
        expect(resolveTrustedSender(event(20, 'https://chat.example.com/'), deps({getCallsWidgetURL: () => undefined}))).toBeUndefined();
        expect(resolveTrustedSender(event(20, 'https://evil.example.org/'), deps())).toBeUndefined();
    });
});
