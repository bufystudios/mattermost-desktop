// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/* eslint-disable no-console, no-process-exit, new-cap, no-await-in-loop, no-return-assign, no-negated-condition */
const {spawn, execSync} = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const electronBin = process.argv[2] || path.join(root, 'node_modules/electron/dist/electron');
const appDir = process.argv[3] || path.join(root, 'dist');
const PORT = 18765;
const PAGE_DEBUG = 19333;
const MAIN_DEBUG = 19229;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real input injection through XTEST (the prebuilt uiohook only posts via XSendEvent, which the global hook never sees).
const koffi = require(path.join(root, 'node_modules/koffi'));
const x11 = koffi.load('libX11.so.6');
const xtst = koffi.load('libXtst.so.6');
const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)');
const XKeysymToKeycode = x11.func('uint8 XKeysymToKeycode(void *d, unsigned long keysym)');
const XFlush = x11.func('int XFlush(void *d)');
const XTestFakeKeyEvent = xtst.func('int XTestFakeKeyEvent(void *d, uint32 keycode, int press, unsigned long delay)');
const XTestFakeButtonEvent = xtst.func('int XTestFakeButtonEvent(void *d, uint32 button, int press, unsigned long delay)');
let xdisp;
const xtest = {
    key(keysym, press) {
        xdisp = xdisp || XOpenDisplay(null);
        XTestFakeKeyEvent(xdisp, XKeysymToKeycode(xdisp, keysym), press ? 1 : 0, 0);
        XFlush(xdisp);
    },
    button(n, press) {
        xdisp = xdisp || XOpenDisplay(null);
        XTestFakeButtonEvent(xdisp, n, press ? 1 : 0, 0);
        XFlush(xdisp);
    },
};
let failures = 0;
const check = (name, ok, extra) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : `  ${JSON.stringify(extra)}`}`);
    if (!ok) {
        failures++;
    }
};

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
    async eval(expression) {
        await this.ready;
        const id = ++this.id;
        const p = new Promise((r) => this.pending.set(id, r));
        this.ws.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}}));
        const res = await Promise.race([p, sleep(20000).then(() => {
            throw new Error(`CDP eval timed out: ${expression.slice(0, 120)}`);
        })]);
        if (res.result.exceptionDetails) {
            throw new Error(JSON.stringify(res.result.exceptionDetails));
        }
        return res.result.result.value;
    }
    close() {
        this.ws.close();
    }
}

async function getJson(url) {
    const res = await fetch(url);
    return res.json();
}

async function waitFor(fn, what, timeout = 60000) {
    const start = Date.now();
    for (;;) {
        try {
            const v = await fn();
            if (v) {
                return v;
            }
        } catch {
            // retry
        }
        if (Date.now() - start > timeout) {
            throw new Error(`timeout waiting for ${what}`);
        }
        await sleep(500);
    }
}

(async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/' || req.url.startsWith('/?') || req.url.startsWith('/channels')) {
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><title>bufy smoke</title><body>bufy smoke page</body>');
        } else {
            res.setHeader('content-type', 'application/json');
            res.end(req.url.includes('ping') ? '{"status":"OK"}' : '{}');
        }
    }).listen(PORT, '127.0.0.1');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bufy-smoke-'));
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
        version: 4,
        servers: [{name: 'smoke', url: `http://127.0.0.1:${PORT}/`, order: 0}],
        showTrayIcon: true,
        trayIconTheme: 'light',
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

    const env = {...process.env};
    delete env.WAYLAND_DISPLAY;
    env.XDG_SESSION_TYPE = 'x11';
    const app = spawn(electronBin, [
        appDir, `--dataDir=${dataDir}`, '--disable-dev-mode', '--no-sandbox', '--ozone-platform=x11', '--disable-gpu',
        `--remote-debugging-port=${PAGE_DEBUG}`, `--inspect=${MAIN_DEBUG}`,
    ], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let log = '';
    app.stdout.on('data', (d) => (log += d));
    app.stderr.on('data', (d) => (log += d));

    const cleanup = () => {
        try {
            app.kill('SIGKILL');
        } catch { /* noop */ }
        server.close();
        fs.rmSync(dataDir, {recursive: true, force: true});
    };

    try {
        const pageTarget = await waitFor(async () => {
            const targets = await getJson(`http://127.0.0.1:${PAGE_DEBUG}/json`);
            return targets.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}`));
        }, 'server page target');
        const page = new Cdp(pageTarget.webSocketDebuggerUrl);

        // Packaged builds have the Node inspector fuse turned off: main-process checks (overlay window flags, global
        // shortcut registry) are then skipped and only the page-level API checks run.
        let main;
        try {
            const mainTarget = (await getJson(`http://127.0.0.1:${MAIN_DEBUG}/json`))[0];
            main = new Cdp(mainTarget.webSocketDebuggerUrl);
        } catch {
            console.log('NOTE  main-process inspector unavailable (packaged build): skipping overlay-window and shortcut-registry checks');
        }

        await waitFor(() => page.eval('typeof window.desktopAPI?.bufy?.version === "string"'), 'desktopAPI.bufy in page');
        check('desktopAPI.bufy present', true, await page.eval('window.desktopAPI.bufy.version'));

        const caps = await page.eval('window.desktopAPI.bufy.getCapabilities()');
        console.log('capabilities', JSON.stringify(caps));
        check('capabilities shape', caps.version && typeof caps.overlay === 'boolean' && typeof caps.globalKeys === 'boolean' && typeof caps.tray === 'boolean');
        check('globalKeys available under Xvfb/X11', caps.globalKeys === true, caps.globalKeysReason);

        // validation
        const bad = await page.eval('window.desktopAPI.bufy.registerPushToTalk({key: "NotAKey"})');
        check('invalid key rejected', bad.ok === false && bad.error === 'invalid-argument', bad);
        const bad2 = await page.eval('window.desktopAPI.bufy.registerShortcut({id: "x", accelerator: "A"})');
        check('bare letter accelerator rejected', bad2.ok === false, bad2);
        const bad3 = await page.eval('window.desktopAPI.bufy.showShareBorder({sourceId: "../../etc", color: "red; x"})');
        check('bad sourceId rejected', bad3.ok === false && bad3.error === 'invalid-argument', bad3);

        // global shortcut registers
        const sc = await page.eval('window.desktopAPI.bufy.registerShortcut({id: "mute", accelerator: "CommandOrControl+Shift+F9"})');
        check('registerShortcut ok', sc.ok === true || sc.error === 'registration-failed', sc);

        // push to talk: simulate with uiohook's own XTEST helper from the main process
        await page.eval('window.__ptt = []; window.desktopAPI.bufy.onPttDown(() => window.__ptt.push("down")); window.desktopAPI.bufy.onPttUp(() => window.__ptt.push("up")); 0');
        const ptt = await page.eval('window.desktopAPI.bufy.registerPushToTalk({key: "F9"})');
        check('registerPushToTalk F9', ptt.ok === true, ptt);
        await sleep(500);
        xtest.key(0xffc6 /* F9 */, true);
        await sleep(150);
        xtest.key(0xffc6, false);
        await sleep(800);
        const events = await page.eval('window.__ptt');
        check('pttDown/pttUp delivered to registering view', events.join() === 'down,up', events);
        const unreg = await page.eval('window.desktopAPI.bufy.unregisterPushToTalk()');
        check('unregisterPushToTalk', unreg.ok === true);

        // mouse button PTT
        const mptt = await page.eval('window.desktopAPI.bufy.registerPushToTalk({key: "Mouse4"})');
        check('registerPushToTalk Mouse4 (mouse button)', mptt.ok === true, mptt);
        await page.eval('window.__ptt.length = 0; 0');
        await sleep(300);
        xtest.button(8 /* X11 "back" button */, true);
        await sleep(150);
        xtest.button(8, false);
        await sleep(600);
        const mevents = await page.eval('window.__ptt');
        check('Mouse4 (back button) down/up delivered', mevents.join() === 'down,up', mevents);
        await page.eval('window.desktopAPI.bufy.unregisterPushToTalk()');

        // left click must never trigger / be bindable
        const leftBind = await page.eval('window.desktopAPI.bufy.registerPushToTalk({key: "Mouse1"})');
        check('left mouse button not bindable', leftBind.ok === false, leftBind);

        // capture helper (not focused page => refused; documented behaviour)
        const cap = await page.eval('window.desktopAPI.bufy.captureNextKey({timeoutMs: 800})');
        check('captureNextKey answers (focus rule / timeout)', cap.ok === false || cap.captured, cap);

        if (main) {
            // overlay: pick any screen source via main process desktopCapturer
            const sources = await main.eval('process.mainModule.require(\'electron\').desktopCapturer.getSources({types: [\'screen\', \'window\'], thumbnailSize: {width: 0, height: 0}}).then((s) => s.map((x) => ({id: x.id, name: x.name, display_id: x.display_id})))');
            console.log('sources', JSON.stringify(sources));
            const screenSrc = sources.find((s) => s.id.startsWith('screen:'));
            const winSrc = sources.find((s) => s.id.startsWith('window:'));
            if (!screenSrc) {
                check('screen source available', false, sources);
            } else {
                const [r, rl] = await page.eval(`Promise.all([window.desktopAPI.bufy.showShareBorder({sourceId: ${JSON.stringify(screenSrc.id)}}), window.desktopAPI.bufy.showShareBorder({sourceId: ${JSON.stringify(screenSrc.id)}})])`);
                check('showShareBorder(screen)', r.ok === true && r.target === 'display', r);
                check('overlay calls rate limited', rl.ok === false && rl.error === 'rate-limited', rl);
                await sleep(300);
                const info = await main.eval('(() => { const {BrowserWindow} = process.mainModule.require(\'electron\'); return BrowserWindow.getAllWindows().filter((w) => (!w.isFocusable() && w.isAlwaysOnTop())).map((w) => ({bounds: w.getBounds(), alwaysOnTop: w.isAlwaysOnTop(), focusable: w.isFocusable(), visible: w.isVisible(), contentProtected: typeof w.isContentProtected === \'function\' ? w.isContentProtected() : null, resizable: w.isResizable()})); })()');
                console.log('overlay windows', JSON.stringify(info));
                check('exactly one overlay window', info.length === 1);
                if (info.length === 1) {
                    check('overlay alwaysOnTop && !focusable && visible', info[0].alwaysOnTop && !info[0].focusable && info[0].visible, info[0]);
                }
                await sleep(300);
                const hide = await page.eval('window.desktopAPI.bufy.hideShareBorder()');
                check('hideShareBorder', hide.ok === true);
                const after = await main.eval('process.mainModule.require(\'electron\').BrowserWindow.getAllWindows().filter((w) => (!w.isFocusable() && w.isAlwaysOnTop())).length');
                check('overlay window destroyed', after === 0, after);
            }

            // window source (follow bounds) using a helper window created in the main process
            const helperId = await main.eval('(() => { const {BrowserWindow} = process.mainModule.require(\'electron\'); const w = new BrowserWindow({x: 120, y: 140, width: 500, height: 300, title: \'bufy-helper\'}); w.loadURL(\'data:text/html,<title>bufy-helper</title>helper\'); global.__helper = w; return new Promise((res) => w.once(\'ready-to-show\', () => { w.show(); res(w.getMediaSourceId()); })); })()');
            console.log('helper media source id', helperId);

            // No window manager under bare Xvfb: publish the window the way an EWMH WM would so desktopCapturer lists it.
            const xid = await main.eval('global.__helper.getNativeWindowHandle().readUInt32LE(0)');
            execSync(`xprop -id ${xid} -f WM_STATE 32c -set WM_STATE 1`);
            execSync(`xprop -root -f _NET_CLIENT_LIST 32x -set _NET_CLIENT_LIST 0x${xid.toString(16)}`);
            await sleep(600);
            const helperSource = await main.eval('process.mainModule.require(\'electron\').desktopCapturer.getSources({types: [\'window\'], thumbnailSize: {width: 0, height: 0}}).then((s) => s.filter((x) => x.name.includes(\'bufy-helper\')).map((x) => x.id))');
            console.log('helper desktopCapturer ids', JSON.stringify(helperSource), winSrc ? '' : '(no window sources listed)');
            if (helperSource.length) {
                await sleep(400);
                const r = await page.eval(`window.desktopAPI.bufy.showShareBorder({sourceId: ${JSON.stringify(helperSource[0])}, color: "#00ff00", thickness: 4})`);
                check('showShareBorder(window) frames the window', r.ok === true && r.target === 'window', r);
                const b1 = await main.eval('global.__helper.getBounds()');
                const ov = () => main.eval('process.mainModule.require(\'electron\').BrowserWindow.getAllWindows().filter((w) => (!w.isFocusable() && w.isAlwaysOnTop())).map((w) => w.getBounds())[0]');
                const o1 = await ov();
                check('overlay bounds == window bounds', JSON.stringify(o1) === JSON.stringify(b1), {o1, b1});
                await main.eval('global.__helper.setBounds({x: 300, y: 260, width: 640, height: 420})');
                await sleep(700);
                const b2 = await main.eval('global.__helper.getBounds()');
                const o2 = await ov();
                check('overlay follows window move/resize', JSON.stringify(o2) === JSON.stringify(b2), {o2, b2});
                await main.eval('global.__helper.minimize()');
                await sleep(500);
                const hiddenWhileMin = await main.eval('process.mainModule.require(\'electron\').BrowserWindow.getAllWindows().filter((w) => (!w.isFocusable() && w.isAlwaysOnTop())).map((w) => w.isVisible())');
                console.log('overlay visibility while window minimized (no WM under bare Xvfb may not unmap)', JSON.stringify(hiddenWhileMin));
                await page.eval('window.__lost = 0; window.desktopAPI.bufy.onShareBorderLost(() => { window.__lost++; }); 0');
                await main.eval('global.__helper.destroy()');
                await sleep(700);
                const lost = await page.eval('window.__lost');
                check('shareBorderLost emitted when shared window closes', lost === 1, lost);
            } else {
                check('helper window listed by desktopCapturer', false);
            }
        }

        // tray voice status
        const st = await page.eval('window.desktopAPI.bufy.setVoiceStatus({connected: true, muted: true, roomName: "Lobby"})');
        check('setVoiceStatus accepted (or tray unavailable)', st.ok === true || st.error === 'unsupported', st);

        if (main) {
            // navigation away clears registrations
            await page.eval('window.desktopAPI.bufy.registerShortcut({id: "nav", accelerator: "CommandOrControl+Shift+F10"})');
            const isReg = (acc) => main.eval(`process.mainModule.require('electron').globalShortcut.isRegistered(${JSON.stringify(acc)})`);
            check('shortcut registered globally', await isReg('CommandOrControl+Shift+F10'));
            await page.eval('location.reload(); 0').catch(() => {});
            await sleep(2500);
            check('shortcut released after page navigation', !(await isReg('CommandOrControl+Shift+F10')));
        }

        page.close();
        main?.close();
    } catch (err) {
        console.error('smoke test error:', err);
        console.error(log.split('\n').slice(-30).join('\n'));
        failures++;
    } finally {
        cleanup();
    }
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();
