// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import fs from 'fs';
import os from 'os';
import path from 'path';

import {BUFY_APP_ID, ensureDesktopEntry, GENERATED_MARKER, renderDesktopEntry} from './desktopEntry';

describe('bufy/desktopEntry', () => {
    let root: string;
    let home: string;
    let sys: string;
    const ctx = (extra: Record<string, string> = {}, execPath = '/opt/Mattermost/com.Mattermost.Desktop') => ({
        env: {XDG_DATA_HOME: path.join(home, 'share'), XDG_DATA_DIRS: sys, ...extra},
        execPath,
        homedir: home,
    });
    const userFile = () => path.join(home, 'share', 'applications', `${BUFY_APP_ID}.desktop`);

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'bufy-desktop-'));
        home = path.join(root, 'home');
        sys = path.join(root, 'usr-share');
        fs.mkdirSync(path.join(sys, 'applications'), {recursive: true});
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    it('uses the same id as package.json desktopName (Electron app_id / packaged .desktop name)', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expect(require('../../../package.json').desktopName).toBe(BUFY_APP_ID);
    });

    it('does nothing when an installed .desktop file exists (deb/rpm)', () => {
        const installed = path.join(sys, 'applications', `${BUFY_APP_ID}.desktop`);
        fs.writeFileSync(installed, '[Desktop Entry]\nName=Mattermost\n');
        expect(ensureDesktopEntry(BUFY_APP_ID, ctx())).toEqual({appId: BUFY_APP_ID, state: 'installed', path: installed});
        expect(fs.existsSync(userFile())).toBe(false);
    });

    it('writes a hidden entry for AppImage/dev runs and points it at $APPIMAGE', () => {
        const res = ensureDesktopEntry(BUFY_APP_ID, ctx({APPIMAGE: '/home/me/Apps/Mattermost.AppImage', APPDIR: '/tmp/.mount_MatterX'}, '/tmp/.mount_MatterX/com.Mattermost.Desktop'));
        expect(res).toMatchObject({state: 'generated', path: userFile()});
        const text = fs.readFileSync(userFile(), 'utf8');
        expect(text).toContain('Exec=/home/me/Apps/Mattermost.AppImage %U');
        expect(text).toContain(`StartupWMClass=${BUFY_APP_ID}`);
        expect(text).toContain('NoDisplay=true');
        expect(text).toContain(GENERATED_MARKER);
    });

    it('ignores an APPIMAGE inherited from another AppImage that launched us', () => {
        ensureDesktopEntry(BUFY_APP_ID, ctx({APPIMAGE: '/home/me/Applications/Other.AppImage', APPDIR: '/tmp/.mount_OtherY'}, '/opt/Mattermost/com.Mattermost.Desktop'));
        const text = fs.readFileSync(userFile(), 'utf8');
        expect(text).toContain('Exec=/opt/Mattermost/com.Mattermost.Desktop %U');
        expect(text).not.toContain('Other.AppImage');
    });

    it('removes its own generated entry once a packaged one is installed, so it does not shadow it', () => {
        ensureDesktopEntry(BUFY_APP_ID, ctx({}, '/a/app'));
        expect(fs.existsSync(userFile())).toBe(true);
        const installed = path.join(sys, 'applications', `${BUFY_APP_ID}.desktop`);
        fs.writeFileSync(installed, '[Desktop Entry]\nName=Mattermost\n');
        expect(ensureDesktopEntry(BUFY_APP_ID, ctx())).toEqual({appId: BUFY_APP_ID, state: 'installed', path: installed});
        expect(fs.existsSync(userFile())).toBe(false);
    });

    it('is idempotent and refreshes a generated entry when the executable moved', () => {
        ensureDesktopEntry(BUFY_APP_ID, ctx({}, '/a/app'));
        expect(ensureDesktopEntry(BUFY_APP_ID, ctx({}, '/a/app')).state).toBe('generated');
        expect(ensureDesktopEntry(BUFY_APP_ID, ctx({}, '/b/app')).state).toBe('refreshed');
        expect(fs.readFileSync(userFile(), 'utf8')).toContain('Exec=/b/app %U');
    });

    it('never overwrites a user file it did not write', () => {
        fs.mkdirSync(path.dirname(userFile()), {recursive: true});
        fs.writeFileSync(userFile(), '[Desktop Entry]\nName=Mine\n');
        expect(ensureDesktopEntry(BUFY_APP_ID, ctx()).state).toBe('installed');
        expect(fs.readFileSync(userFile(), 'utf8')).toBe('[Desktop Entry]\nName=Mine\n');
    });

    it('reports failure instead of throwing', () => {
        const res = ensureDesktopEntry(BUFY_APP_ID, {
            ...ctx(),
            fs: {
                existsSync: () => false,
                readFileSync: () => '',
                writeFileSync: () => {
                    throw new Error('read-only');
                },
                mkdirSync: () => undefined,
                unlinkSync: () => undefined,
            },
        });
        expect(res.state).toBe('failed');
    });

    it('quotes an Exec path with spaces', () => {
        expect(renderDesktopEntry(BUFY_APP_ID, '/opt/My App/mm')).toContain('Exec="/opt/My App/mm" %U');
    });
});
