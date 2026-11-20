// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/* eslint-disable no-console, no-process-exit, no-await-in-loop, no-return-assign */

// Live check of the Wayland push-to-talk / global shortcuts backend (xdg-desktop-portal GlobalShortcuts) in the REAL
// desktop session (KDE Plasma / GNOME). Unlike bufy-smoke.js it does not force X11 and cannot press keys for you:
//
//   node scripts/bufy-wayland-live.js [electron-binary] [app-dir] [--wait=SECONDS] [--key=F13]
//
// It starts the app against a fake local "server", registers push-to-talk + three toggles, prints what the compositor
// bound, then listens for `--wait` seconds (default 30) while YOU press the keys. The compositor shows a
// confirmation dialog the first time: confirm it. See docs/bufy/wayland-ptt-test.md.
// It always unregisters and quits the app when it is done (also on Ctrl+C).

const {spawn} = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name, def) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${def}`).split('=')[1];
const electronBin = positional[0] || path.join(root, 'node_modules/electron/dist/electron');
const appDir = positional[1] || path.join(root, 'dist');
const WAIT_S = Number(flag('wait', 30));
const KEY = flag('key', 'F13');
const PORT = 18766;
const PAGE_DEBUG = 19334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => (await fetch(url)).json();

class Cdp {
    constructor(wsUrl) {
        this.id = 0;
        this.pending = new Map();
        this.ws = new WebSocket(wsUrl);
        this.ready = new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
        });
        this.ws.onmessage = (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id && this.pending.has(msg.id)) {
                this.pending.get(msg.id)(msg);
                this.pending.delete(msg.id);
            }
        };
    }
    async eval(expression, timeoutMs = 20000) {
        await this.ready;
        const id = ++this.id;
        const p = new Promise((r) => this.pending.set(id, r));
        this.ws.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}}));
        const res = await Promise.race([p, sleep(timeoutMs).then(() => {
            throw new Error(`CDP eval timed out: ${expression.slice(0, 100)}`);
        })]);
        if (res.result.exceptionDetails) {
            throw new Error(JSON.stringify(res.result.exceptionDetails));
        }
        return res.result.result.value;
    }
}

(async () => {
    if (process.env.XDG_SESSION_TYPE !== 'wayland') {
        console.log(`NOTE  XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE}: this is not a Wayland session, the uiohook backend will be used.`);
    }
    const server = http.createServer((req, res) => {
        res.setHeader('content-type', req.url.includes('ping') ? 'application/json' : 'text/html');
        res.end(req.url.includes('ping') ? '{"status":"OK"}' : '<!doctype html><title>bufy wayland live</title><body>bufy wayland live</body>');
    }).listen(PORT, '127.0.0.1');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bufy-wayland-'));
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
        version: 4,
        servers: [{name: 'live', url: `http://127.0.0.1:${PORT}/`, order: 0}],
        showTrayIcon: false,
        minimizeToTray: false,
        notifications: {flashWindow: 0, bounceIcon: false, bounceIconType: 'informational'},
        showUnreadBadge: true,
        useSpellChecker: false,
        enableHardwareAcceleration: false,
        autostart: false,
        hideOnStart: false,
        spellCheckerLocales: [],
        darkMode: false,
        lastActiveServer: 0,
        startInFullscreen: false,
        autoCheckForUpdates: false,
        appLanguage: 'en',
        logLevel: 'info',
        viewLimit: 15,
    }));

    const app = spawn(electronBin, [appDir, `--dataDir=${dataDir}`, '--disable-dev-mode', `--remote-debugging-port=${PAGE_DEBUG}`], {stdio: ['ignore', 'pipe', 'pipe']});
    let log = '';
    app.stdout.on('data', (d) => (log += d));
    app.stderr.on('data', (d) => (log += d));

    let page;
    const cleanup = async () => {
        try {
            if (page) {
                await page.eval('window.desktopAPI.bufy.unregisterPushToTalk()', 5000);
                console.log('events after unregister (a held key must have been released):', JSON.stringify(await page.eval('window.__ev', 5000)));
                await page.eval('Promise.all(["toggle-mute","toggle-deafen","toggle-golive"].map((i) => window.desktopAPI.bufy.unregisterShortcut(i)))', 5000);
                await sleep(500);
            }
        } catch { /* best effort */ }
        try {
            app.kill('SIGTERM');
            await sleep(1500);
            app.kill('SIGKILL');
        } catch { /* already gone */ }
        server.close();
        fs.rmSync(dataDir, {recursive: true, force: true});
        const lines = log.split('\n').filter((l) => (/Bufy|portal/i).test(l));
        if (lines.length) {
            console.log('--- app log (Bufy/portal) ---');
            console.log(lines.slice(-15).join('\n'));
        }
    };
    process.on('SIGINT', () => cleanup().then(() => process.exit(130)));

    try {
        for (let i = 0; i < 120 && !page; i++) {
            try {
                const t = (await getJson(`http://127.0.0.1:${PAGE_DEBUG}/json`)).find((x) => x.type === 'page' && x.url.startsWith(`http://127.0.0.1:${PORT}`));
                if (t) {
                    page = new Cdp(t.webSocketDebuggerUrl);
                }
            } catch { /* not up yet */ }
            await sleep(500);
        }
        if (!page) {
            throw new Error('app page did not come up');
        }
        for (let i = 0; i < 60 && !(await page.eval('typeof window.desktopAPI?.bufy?.version === "string"').catch(() => false)); i++) {
            await sleep(500);
        }

        const caps = await page.eval('window.desktopAPI.bufy.getCapabilities()');
        console.log('capabilities', JSON.stringify(caps));
        if (!caps.globalKeys) {
            console.log(`RESULT  global keys unsupported: ${caps.globalKeysReason}`);
            return;
        }

        await page.eval(`window.__ev = []; const b = window.desktopAPI.bufy;
            b.onPttDown(() => window.__ev.push('ptt-down@' + Date.now()));
            b.onPttUp(() => window.__ev.push('ptt-up@' + Date.now()));
            b.onShortcut((id) => window.__ev.push('shortcut:' + id));
            b.onShortcutTriggerChanged((c) => window.__ev.push('trigger-changed:' + JSON.stringify(c)));
            0`);

        console.log('Registering push-to-talk + toggles. On Wayland the system may now show a confirmation dialog: confirm it (up to 120 s)...');
        const results = await page.eval(`Promise.all([
            window.desktopAPI.bufy.registerPushToTalk({key: ${JSON.stringify(KEY)}}),
            window.desktopAPI.bufy.registerShortcut({id: 'toggle-mute', accelerator: 'CommandOrControl+Shift+M'}),
            window.desktopAPI.bufy.registerShortcut({id: 'toggle-deafen', accelerator: 'CommandOrControl+Shift+D'}),
            window.desktopAPI.bufy.registerShortcut({id: 'toggle-golive', accelerator: 'CommandOrControl+Shift+L'}),
        ])`, 130000);
        console.log('registration results', JSON.stringify(results, null, 1));
        if (!results.every((r) => r.ok)) {
            console.log('RESULT  not (fully) bound; see the results above');
            return;
        }

        console.log(`Bound. Press the keys now (listening for ${WAIT_S} s)...`);
        let seen = 0;
        for (let t = 0; t < WAIT_S; t++) {
            await sleep(1000);
            const ev = await page.eval('window.__ev');
            if (ev.length !== seen) {
                console.log('events:', JSON.stringify(ev.slice(seen)));
                seen = ev.length;
            }
        }
        console.log('RESULT  events seen:', JSON.stringify(await page.eval('window.__ev')));
    } catch (err) {
        console.log('FAIL', err.message);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
