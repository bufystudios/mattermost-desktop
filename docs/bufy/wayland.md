# Wayland: global push-to-talk and shortcuts

Wayland has no API for reading keys globally (that is the point of the protocol), so the X11 hook (`uiohook-napi`) cannot work there.
On Linux Wayland the Bufy API therefore uses the **xdg-desktop-portal GlobalShortcuts** interface
([`org.freedesktop.portal.GlobalShortcuts`](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)):
the *compositor* owns the key assignment and tells the app "shortcut `ptt` became active / inactive". That gives real key-down and key-up
events for push-to-talk. Overview of the API: [README.md](README.md#global-keys). Hand test: [wayland-ptt-test.md](wayland-ptt-test.md).

Contents: [Backend selection](#backend-selection) · [What the user sees](#what-the-user-sees) · [API differences](#api-differences-on-the-portal-backend) ·
[App id](#app-id-so-the-compositor-remembers-the-keys) · [Compositor support](#compositor-support) · [Electron's built-in portal path](#why-not-electrons-globalshortcut) ·
[Mouse buttons](#mouse-buttons) · [Share-border overlay](#share-border-overlay-on-wayland) · [Implementation](#implementation)

## Backend selection

`getCapabilities().globalKeysBackend`:

| session | backend | push-to-talk | toggles (`registerShortcut`) | `captureNextKey` |
|---|---|---|---|---|
| Windows, macOS, Linux X11 | `uiohook` | native hook, down/up | Electron `globalShortcut` | yes |
| Linux Wayland **and** the portal offers `GlobalShortcuts` (`version` ≥ 1) | `portal` | portal `Activated`/`Deactivated` | portal `Activated` | `unsupported-on-wayland` |
| Linux Wayland without it | `null` | `unsupported` | `unsupported` (`shortcuts: false`) | `unsupported-on-wayland` |

A session counts as Wayland when `XDG_SESSION_TYPE=wayland` or `WAYLAND_DISPLAY` is set. The portal check reads the `version` property of the
interface on the session bus (a private, short-lived D-Bus connection; positive answers are cached, negative ones retried after 30 s).
When it fails, `globalKeysReason` says why:

| `globalKeysReason` | meaning |
|---|---|
| `wayland-no-portal` | no session bus, or `xdg-desktop-portal` is not running |
| `wayland-no-global-shortcuts` | portal runs but has no `GlobalShortcuts` (old portal, or a portal backend without it, e.g. GNOME < 48) |

Failures *while registering* use `registration-failed`; `message` starts with `wayland-no-app-id:` when the portal could not resolve the app id (see below).

## What the user sees

* **First registration**: `registerPushToTalk` / `registerShortcut` call `CreateSession` + `BindShortcuts`. The compositor may show its own
  confirmation/assignment dialog (GNOME: "Add Keyboard Shortcuts" dialog; KDE: normally nothing when the suggested keys are free, otherwise the KDE dialog).
  The promise resolves **after** the user answered it, so do not block your UI on it, and show a hint such as "confirm the system dialog".
  The portal call itself times out after 120 s (`timeout`).
* **The user decides the key.** `preferred_trigger` (derived from the requested key, e.g. `F13`, `CTRL+SHIFT+m`) is only a suggestion. The result tells you what
  is *really* bound: `{ok: true, backend: 'portal', trigger: 'Ctrl+Alt+P', requestedTrigger: 'CTRL+ALT+p'}`.
  Show `trigger` in your UI ("PTT: bound by the system to Ctrl+Alt+P").
* **Later changes**: the user can re-assign or clear a key in the system settings (KDE: *System Settings → Keyboard → Shortcuts → Mattermost*; GNOME: the
  Settings app, per application). The compositor then emits `ShortcutsChanged`, delivered as `onShortcutTriggerChanged({id, trigger})`
  (`id` is `ptt` for push-to-talk; an empty `trigger` means "no longer bound"). `openShortcutSettings()` opens that settings UI (portal v2 `ConfigureShortcuts`).
* **Persistence**: the compositor stores the assignment per app id + shortcut id, so on the next start the same keys are active **without** asking again
  (verified on KDE Plasma 6.8: stored in `~/.config/kglobalshortcutsrc` under `[com.Mattermost.Desktop]`).
  Re-registering with another `key` does *not* change an already assigned key, only the settings UI does.

## API differences on the portal backend

* `registerPushToTalk` / `registerShortcut` resolve with `BindingInfo` (`backend`, `trigger`, `requestedTrigger`). With `uiohook` there is no `trigger` (it is what you asked for).
* `captureNextKey` → `{ok: false, error: 'unsupported-on-wayland'}` (also `keyCapture: false` in the capabilities). Plugins should **not** show a "press the key you
  want" capture UI on Wayland. Instead: call `registerPushToTalk({key: <default>})`, let the system dialog assign the key, and show the returned `trigger`
  plus a button calling `openShortcutSettings()`.
* `registerShortcut` ids are the portal shortcut ids (`toggle-mute`, ...), so keep them **stable** across versions: renaming an id makes the compositor forget the key. `ptt` is reserved for push-to-talk
  (`invalid-argument` as a shortcut id). Two views cannot register the same id (`in-use`); max 16 per view as before. Accelerator safety rules still apply.
* The portal allows `BindShortcuts` only once per session, so adding another shortcut later closes the session and binds the full set again (all shortcuts of
  the app, collected within 100 ms, are bound together). Already confirmed shortcuts are restored by the compositor without a second dialog. A held key is released (`pttUp`) first.
* Cleanup: session `Close` + D-Bus connection close on unregister of the last binding, view teardown (reload, navigation, crash, view/server removal) and app quit;
  `pttUp` is sent first if the key was held. If the compositor closes the session or the bus connection drops, held keys are released and every owner gets
  `onShortcutTriggerChanged({id, trigger: ''})` so the plugin can re-register.

## App id (so the compositor remembers the keys)

Portals identify a non-sandboxed app by an **app id** that must match an installed `<app id>.desktop` file
(`org.freedesktop.host.portal.Registry.Register`; xdg-desktop-portal ≥ 1.19 offers it, ≥ 1.21 refuses sessions for ids it cannot resolve; without any id the portal answers
`NotAllowed: An app id is required` — verified here). The compositor files the shortcuts under that id.

| | |
|---|---|
| app id | `com.Mattermost.Desktop` = `desktopName` in `package.json` (also Electron's Wayland `app_id`, and `StartupWMClass` in the generated `.desktop`) |
| deb / rpm | electron-builder installs `/usr/share/applications/com.Mattermost.Desktop.desktop` (name from `linux.executableName`), so the id is stable and the compositor shows "Mattermost" in its settings |
| AppImage / tar.gz / dev run | nothing installs a `.desktop` file, so before the first registration the app writes a minimal hidden one to `$XDG_DATA_HOME/applications/com.Mattermost.Desktop.desktop` (`NoDisplay=true`, `X-Bufy-Generated=true`, `Exec` = `$APPIMAGE` or the executable). It never overwrites a file it did not write, and refreshes its own when the executable moves |
| the stock Mattermost app | uses the same id; only one of the two runs at a time (single-instance lock) and they would share the stored keys, which is what you want when replacing the stock app |

Do not change the id or the desktop file name in a release: the user would have to assign the keys again.

## Compositor support

| compositor | status | notes |
|---|---|---|
| **KDE Plasma 6** (tested: 6.8.2, xdg-desktop-portal 1.22.1, `GlobalShortcuts` v2) | works | preferred triggers that are free are accepted silently; keys stored in `kglobalshortcutsrc`; key down **and** up delivered. Plasma 5.27+ has the portal too ([xdg-desktop-portal-kde](https://invent.kde.org/plasma/xdg-desktop-portal-kde)) |
| **GNOME 48+** | supported by the platform ([GNOME 48 release notes](https://release.gnome.org/48/developers/)) | not tested here. Shows a dialog on first bind; early 48.x had dialog bugs ([discussion](https://discourse.gnome.org/t/issue-with-global-shortcuts-setup-popup-in-gnome-48/27946)); GNOME 50 refuses binds when the app id is not a valid reverse-DNS id with an installed `.desktop` file, which is why the app id handling above exists ([Electron docs](https://www.electronjs.org/docs/latest/api/app#appsetdesktopnamedesktopname-linux)) |
| GNOME < 48, Mutter-based forks without the backend | `wayland-no-global-shortcuts` | plugins fall back to in-window keys |
| wlroots (Sway, Hyprland, ...) | depends on the portal backend installed; `xdg-desktop-portal-hyprland` has `GlobalShortcuts`, `xdg-desktop-portal-wlr` does not | untested |

## Why not Electron's `globalShortcut`?

Electron 45 / Chromium already contain a `GlobalShortcutsPortal` feature, and on this build `globalShortcut.register()` *does* talk to the portal on Wayland **without** any flag
(measured with a D-Bus monitor: it calls `Registry.Register` + `CreateSession` and returns `true` immediately). It is not enough for us:

* `register()` returns `true` before the portal answered, so a dismissed dialog or a failed bind is never reported;
* there is no way to learn which key the user actually got, and no key-*up*, so no push-to-talk;
* every accelerator opens its own session (and possibly its own dialog) under the same app id.

So on Wayland the fork **never calls `globalShortcut`**; push-to-talk *and* the toggles share one portal session of ours
(`src/main/bufy/portalKeys.ts`), which also guarantees nothing is registered twice. Do not enable `--enable-features=GlobalShortcutsPortal`
explicitly and do not call `globalShortcut` from other code on Wayland, or two sessions would compete for the same app id.
(Verified: with the app idle and one registration through the API, only one connection — ours — calls `CreateSession`.)

## Mouse buttons

The portal's trigger syntax (`CTRL+ALT+x`, XKB keysyms) has no mouse buttons, and KDE's *Shortcuts* module only accepts keyboard keys. `registerPushToTalk({key: 'Mouse4'})` therefore
binds `ptt` **without a suggested trigger**; the user assigns a key in the system UI. Practical options for "side button as push-to-talk" on Wayland:
map the mouse button to a rarely used key such as `F13` with the device layer (`input-remapper`, `libratbag`/Piper, the vendor tool) and assign that key to `ptt`.
`requestedTrigger` is absent in the result for mouse buttons so a plugin can explain this.

## Share-border overlay on Wayland

The overlay stays at phase-A behaviour on Wayland: `overlayFollowsWindow: false`, and window shares frame a display. What was investigated for "frame the monitor the user actually chose":

* The monitor choice happens in Chromium's own ScreenCast portal session (PipeWire). The stream metadata that includes the monitor's position/size
  (`streams[].position`, `size` from the ScreenCast `Start` response) is only returned to the client that created that session, i.e. Chromium's D-Bus connection.
  Another process cannot read it, and creating a second ScreenCast session of our own would show a second picker. Not feasible without patching Chromium.
* What a plugin *can* do: `MediaStreamTrack.getSettings()` of the captured video has `width`/`height` and `displaySurface: 'monitor'`; matching that against
  `screen.getAllDisplays()` (size × scale factor) identifies the monitor when the monitors differ in resolution. This is a heuristic that fails for identical monitors,
  so it is not wired in.
* Even with the right monitor known, an Electron window cannot be *placed* on a given monitor on Wayland (client-side positioning is ignored; `xdg-shell` has no
  absolute position, no layer-shell in Chromium) and "always on top" is a compositor decision. On KDE the realistic way would be a KWin script (loaded over
  `org.kde.KWin /Scripting`, the way `kdotool` works) that reads the outputs and pins our overlay window above everything on the right output. That is a compositor-privileged
  operation and KDE-only, so it was **not** implemented; it would be a separate decision.
* `desktopCapturer.getSources()` on Wayland goes through the portal picker as well, so the `sourceId` verification in `showShareBorder` may re-open the picker or
  not find the source. This was not exercised (it needs a human click) and is the first thing to check if the border is wanted on Wayland.

## Implementation

| file | role |
|---|---|
| `src/main/bufy/keysBackend.ts` | picks the backend, routes push-to-talk / toggles / capture / cleanup |
| `src/main/bufy/portalKeys.ts` | one shared portal session: batching, entries, `Activated`/`Deactivated`/`ShortcutsChanged`, cleanup, held-key release |
| `src/main/bufy/portalClient.ts` | GlobalShortcuts protocol (Registry.Register, CreateSession, BindShortcuts via Request/Response, ListShortcuts, ConfigureShortcuts, Session.Close) against a small `PortalBus` interface |
| `src/main/bufy/portalBus.ts` | `PortalBus` on [`dbus-native`](https://github.com/sidorares/dbus-native) 0.16.3 (MIT, pure JS, only dependency `xml2js`; loaded lazily; installs the error listener the library does not) |
| `src/main/bufy/portalTrigger.ts` | `KeyboardEvent.code` / Electron accelerator → portal `preferred_trigger` (`CTRL+SHIFT+m`, `F13`, `KP_0`, ...) |
| `src/main/bufy/desktopEntry.ts` | app id constant and the generated `.desktop` file |
| `src/main/bufy/testing/fakePortalBus.ts` | in-memory portal for the unit tests |
| `scripts/bufy-wayland-live.js` | live check in a real Wayland session |

`dbus-native` is a webpack *external* (`webpack.config.main.js`) and is whitelisted with its dependencies in `electron-builder.bufy.ts` (`xml2js`, `sax`),
like `uiohook-napi`. (The nested `xmlbuilder` of `xml2js` is not packed by electron-builder; it is only needed for D-Bus introspection, which the portal backend never uses.) It was chosen over `dbus-next` (also MIT) because `dbus-next` has had no release since 2022 and drags an optional native `usocket` → `node-gyp` → deprecated `request` tree into the lockfile.
