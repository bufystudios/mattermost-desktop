// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: the app identity xdg-desktop-portal needs for GlobalShortcuts on Wayland.
//
// The portal identifies a host (non-Flatpak) app by an *app id* that must resolve to an installed
// `<app id>.desktop` file (xdg-desktop-portal >= 1.19 `org.freedesktop.host.portal.Registry.Register`, and
// >= 1.21 refuses sessions for ids it cannot resolve). The compositor stores the user's chosen shortcuts under
// that id, so it must be stable. We use the `desktopName` from package.json (`com.Mattermost.Desktop`), which is
// also what Electron uses as the Wayland `app_id` and what electron-builder names the packaged `.desktop` file.
//
// Packaged builds (deb/rpm) ship that file. For AppImage, tar.gz and dev runs nothing installs it, so we write a
// minimal, hidden one into `$XDG_DATA_HOME/applications` (marked `X-Bufy-Generated=true`; refreshed when the
// executable moves; never overwrites a file we did not write).

import fs from 'fs';
import os from 'os';
import path from 'path';

import {Logger} from 'common/log';

const log = new Logger('Bufy.DesktopEntry');

export const BUFY_APP_ID = 'com.Mattermost.Desktop';
export const GENERATED_MARKER = 'X-Bufy-Generated=true';

export type DesktopEntryFs = {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string, enc: 'utf8') => string;
    writeFileSync: (p: string, data: string, opts?: {mode?: number}) => void;
    mkdirSync: (p: string, opts: {recursive: true}) => unknown;
};

export type DesktopEntryEnv = {
    env: NodeJS.ProcessEnv;
    execPath: string;
    homedir: string;
    fs?: DesktopEntryFs;
};

export function dataDirs(env: NodeJS.ProcessEnv, homedir: string): string[] {
    const home = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
    const system = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
    return [home, ...system];
}

function entryPath(dir: string, appId: string) {
    return path.join(dir, 'applications', `${appId}.desktop`);
}

export function renderDesktopEntry(appId: string, exec: string): string {
    // Exec needs quoting when it contains spaces; backslash and quote are escaped per the Desktop Entry spec.
    const quoted = (/[\s"'\\]/).test(exec) ? `"${exec.replace(/(["`$\\])/g, '\\$1')}"` : exec;
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Mattermost',
        'Comment=Mattermost (Bufy build)',
        `Exec=${quoted} %U`,
        `StartupWMClass=${appId}`,
        'Categories=Network;InstantMessaging;',
        'NoDisplay=true',
        GENERATED_MARKER,
        '',
    ].join('\n');
}

export type EnsureResult = {
    appId: string;
    state: 'installed' | 'generated' | 'refreshed' | 'failed';
    path?: string;
    error?: string;
};

/**
 * Makes sure `<appId>.desktop` exists somewhere in the XDG data dirs. Idempotent and cheap; only writes when no file
 * exists, or when a previously generated file points at another executable.
 */
export function ensureDesktopEntry(appId: string, ctx: DesktopEntryEnv): EnsureResult {
    const f = ctx.fs ?? fs;
    const dirs = dataDirs(ctx.env, ctx.homedir);
    const exec = ctx.env.APPIMAGE || ctx.execPath;
    const userFile = entryPath(dirs[0], appId);

    for (const dir of dirs) {
        const p = entryPath(dir, appId);
        if (!f.existsSync(p)) {
            continue;
        }
        if (p !== userFile) {
            return {appId, state: 'installed', path: p};
        }
        try {
            const current = f.readFileSync(p, 'utf8');
            if (!current.includes(GENERATED_MARKER)) {
                return {appId, state: 'installed', path: p}; // the user's (or a packager's) own file
            }
            const wanted = renderDesktopEntry(appId, exec);
            if (current === wanted) {
                return {appId, state: 'generated', path: p};
            }
            f.writeFileSync(p, wanted, {mode: 0o644});
            return {appId, state: 'refreshed', path: p};
        } catch (err) {
            return {appId, state: 'failed', path: p, error: String(err)};
        }
    }

    try {
        f.mkdirSync(path.dirname(userFile), {recursive: true});
        f.writeFileSync(userFile, renderDesktopEntry(appId, exec), {mode: 0o644});
        log.info('wrote desktop entry for xdg-desktop-portal', {path: userFile});
        return {appId, state: 'generated', path: userFile};
    } catch (err) {
        log.warn('could not write desktop entry', {err});
        return {appId, state: 'failed', path: userFile, error: String(err)};
    }
}

export function defaultDesktopEntryEnv(): DesktopEntryEnv {
    return {env: process.env, execPath: process.execPath, homedir: os.homedir()};
}
