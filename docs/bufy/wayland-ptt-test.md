# Testing push-to-talk on Wayland by hand

Applies to Linux Wayland (KDE Plasma 5.27+/6, GNOME 48+). Background and design: [wayland.md](wayland.md).
Nobody can press keys for you from a script, so this is the short manual check. Nothing here needs a server or a plugin.

## A. Scripted (recommended)

Dev build (`npm run build` first) or an unpacked package:

```bash
node scripts/bufy-wayland-live.js                       # dev build in ./dist, key F13, listens 30 s
node scripts/bufy-wayland-live.js --key=F9 --wait=60
# packaged build (extracted tar.gz):
node scripts/bufy-wayland-live.js /path/to/mattermost-desktop-bufy-6.4.0/com.Mattermost.Desktop /path/to/.../resources/app.asar
```

What it does: starts the app against a fake local server (own temp data dir, your real settings are not touched), prints `getCapabilities()`, registers
push-to-talk (`F13` by default) and the toggles `toggle-mute` (Ctrl+Shift+M), `toggle-deafen` (Ctrl+Shift+D), `toggle-golive` (Ctrl+Shift+L), prints what the compositor bound,
then prints every `ptt-down` / `ptt-up` / `shortcut:<id>` / `trigger-changed` event while you press keys. On exit it unregisters everything and quits the app.

**What you have to do once:**

1. If the system shows a dialog ("Add keyboard shortcuts" / Mattermost wants to register shortcuts), **confirm it** (accept the suggested keys or pick your own). On KDE Plasma 6.8 no dialog
   appeared in our test because the suggested keys were free; on GNOME expect one. The script waits up to 120 s.
2. Press and hold the bound key (the script prints it as `trigger`): expect `ptt-down`, then `ptt-up` when you release. Press the toggle combos: expect `shortcut:toggle-mute` etc.
3. Optional: change the key in the system settings while the script listens: expect `trigger-changed {"id":"ptt","trigger":"…"}`
   (KDE: *System Settings → Keyboard → Shortcuts → Mattermost*).

Expected output (KDE Plasma 6.8, abbreviated):

```
capabilities {... "globalKeys":true,"globalKeysBackend":"portal","keyCapture":false, ...}
registration results [ {"ok":true,"backend":"portal","trigger":"F13","requestedTrigger":"F13"}, {... "trigger":"Ctrl+Shift+M" ...}, ...]
Bound. Press the keys now (listening for 30 s)...
events: ["ptt-down@1795198039736"]
events: ["ptt-up@1795198039912"]
```

Run it a second time: the same keys must be active **without** a dialog (the compositor remembers them per app id).

### Resetting what the test registered

The compositor keeps the keys after the app exits (that is the point). To remove them:

```bash
# KDE: drop the whole component (also visible/removable in System Settings → Shortcuts)
busctl --user call org.kde.kglobalaccel /component/com_Mattermost_Desktop org.kde.kglobalaccel.Component cleanUp
# the .desktop file the app generated for dev/AppImage runs (packaged deb/rpm installs its own and needs nothing):
rm -f ~/.local/share/applications/com.Mattermost.Desktop.desktop
```

## B. From the DevTools console of a real server tab

Open DevTools in a Mattermost tab (`Ctrl+Shift+I`, dev builds / `View → Developer Tools`) and paste:

```js
const b = window.desktopAPI.bufy;
console.log(await b.getCapabilities());          // globalKeysBackend should be 'portal'
b.onPttDown(() => console.log('PTT down'));
b.onPttUp(() => console.log('PTT up'));
b.onShortcut((id) => console.log('shortcut', id));
b.onShortcutTriggerChanged((c) => console.log('trigger changed', c));
// the system dialog may appear now; the promise resolves after you answered it
console.log(await b.registerPushToTalk({key: 'F13'}));      // -> {ok, backend:'portal', trigger:'…'}
console.log(await b.registerShortcut({id: 'toggle-mute', accelerator: 'CommandOrControl+Shift+M'}));
console.log(await b.captureNextKey());           // -> {ok:false, error:'unsupported-on-wayland'}
// ...press keys...
await b.openShortcutSettings();                  // opens the system shortcut settings
await b.unregisterPushToTalk();
await b.unregisterShortcut('toggle-mute');
```

## What was verified automatically on KDE Plasma 6.8.2 / Wayland (Fedora 44, xdg-desktop-portal 1.22.1)

* capabilities report `portal`; push-to-talk and three toggles bound in **one** session, KDE reported `F13`, `Ctrl+Shift+M/D/L` and stored them under `[com.Mattermost.Desktop]`;
* `Activated` → `ptt-down` and `shortcut:<id>` reached the page (triggered with `kglobalaccel … invokeShortcut`, which only emits the *press*);
* a key still held at unregister/quit produced `ptt-up`; the session and the D-Bus connection were closed;
* not verifiable without a keyboard: a physical key *release* (`Deactivated`) → `ptt-up`. The unit tests cover that mapping; please confirm it once with step A.2.
