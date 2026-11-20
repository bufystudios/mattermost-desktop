# Building the Bufy desktop app yourself

Unsigned builds for Linux, Windows and macOS. Linux and Windows are built in a pinned container (Docker or Podman),
macOS has to be built on a Mac. Overview of the fork: [README.md](README.md).

| Target | How | Artifacts |
|---|---|---|
| Linux x64 + arm64 | `./docker/build.sh linux` | `.deb`, `.rpm`, `.AppImage`, `.tar.gz` |
| Windows x64 | `./docker/build.sh windows` | NSIS `-setup.exe`, portable `.zip` |
| macOS arm64/x64 | `./scripts/bufy-build-mac.sh` (on a Mac) | `.zip` (+ `.dmg`), ad-hoc signed |

All artifacts end up in **`release/bufy/`** (git-ignored; upstream's `dist/` is the webpack output of the app itself and
must not be mixed with packages).

## Prerequisites

- **Linux / Windows packages**: Docker (or Podman, rootless is fine; `docker` may be a podman shim), ~10 GB free disk
  (builder image 4.7 GB + caches), network access to GitHub (Electron, electron-builder tools) and npm.
  The container image is pinned by digest in `docker/Dockerfile` (`electronuserland/builder:wine`: Ubuntu 22.04, Node 24, Wine 11).
  Nothing is installed on the host. `git` and a checkout of this repo (branch `bufy/main`) are enough.
- **macOS package**: a Mac, Node ≥ 24 (see `.nvmrc`), Xcode command line tools (`xcode-select --install`).
  Build on the architecture you need (or `universal`): native modules and `codesign` need macOS.
- Local development: Node ≥ 24, `npm install`, `npm run build && npm start` (see upstream `CONTRIBUTING.md`).

## Commands

```bash
./docker/build.sh linux                 # x64 + arm64 (deb, rpm, AppImage, tar.gz)
./docker/build.sh linux --arch x64      # only x64 (faster)
./docker/build.sh windows               # x64 NSIS installer + zip
./docker/build.sh all
./docker/build.sh linux --engine podman # force an engine
./docker/build.sh linux --no-cache      # rebuild the builder image

./scripts/bufy-build-mac.sh             # on a Mac: the Mac's own arch
./scripts/bufy-build-mac.sh universal
```

How it works: the repo is mounted read-only into the container, copied to a scratch volume, `npm ci --ignore-scripts` + `patch-package`
run there (cached in a per-target volume, redone only when `package-lock.json`/`patches/` change), the app is built with webpack in
production mode and packaged with `electron-builder --config electron-builder.bufy.ts` (an overlay on upstream's unchanged
`electron-builder.ts`). Your working tree is never written to except `release/bufy/`. Downloads (Electron, electron-builder tools) are cached
in the `bufy-builder-cache` volume; remove the volumes with `podman volume rm bufy-builder-cache bufy-builder-work-linux bufy-builder-work-windows`.

Not built: Flatpak (needs flatpak-builder + runtimes), Windows MSI (needs WiX), Windows arm64, Mac App Store.

## Install

### Linux

```bash
# Debian/Ubuntu - replaces the stock mattermost-desktop package (Conflicts/Replaces/Provides)
sudo apt install ./release/bufy/mattermost-desktop-bufy_6.4.0-1_amd64.deb
# Fedora/RHEL/openSUSE
sudo dnf install ./release/bufy/mattermost-desktop-bufy-6.4.0.x86_64.rpm
# Any distro, no install
chmod +x mattermost-desktop-bufy-6.4.0-linux-x86_64.AppImage && ./mattermost-desktop-bufy-6.4.0-linux-x86_64.AppImage
# or unpack the .tar.gz and run ./mattermost-desktop-bufy-*/com.Mattermost.Desktop
```

The app keeps using `~/.config/Mattermost` (same as the stock app), so servers and sessions carry over. The AppImage needs FUSE 2
(`libfuse2`) or `--appimage-extract-and-run`. Global keys work on X11, and on Wayland through the desktop portal (see below). The deb depends on `libxt6`, the
rpm on `libXt` (pulled in automatically; the AppImage/tar.gz need it installed: `apt install libxt6` / `dnf install libXt`).

The deb/rpm install both `/usr/bin/com.Mattermost.Desktop` and the old `/usr/bin/mattermost-desktop` command (stock <= 6.3 used that name;
upgrading used to leave it dangling). Their install/remove scripts live in `resources/linux/bufy/` (upstream templates plus that alias, and
a remove script that only cleans up on a real uninstall, not on upgrades).

### Windows

Run `mattermost-desktop-bufy-6.4.0-win-x64-setup.exe` (per-user install, no admin needed, choose the folder on the second page), or unzip
the `.zip` and run `Mattermost.exe`. The installer is **unsigned**, so SmartScreen shows "Windows protected your PC": **More info → Run anyway**.
Servers/sessions are shared with the stock app (`%APPDATA%\Mattermost`). If the stock MSI is installed, uninstall it first (both
register the `mattermost://` handler and share one single-instance lock).

### macOS

1. Unzip, drag **Mattermost.app** to `/Applications` (replace the stock app; data in `~/Library/Application Support/Mattermost` is kept).
2. The app is ad-hoc signed, **not notarized**, so Gatekeeper blocks the first launch ("cannot be opened because the developer cannot be verified"):
   right-click the app → **Open** → **Open**, or *System Settings → Privacy & Security → "Mattermost was blocked" → **Open Anyway***, or
   `xattr -dr com.apple.quarantine /Applications/Mattermost.app`.
3. Grant the permissions below.

## Permissions

| OS | What | Where / why |
|---|---|---|
| macOS | **Accessibility** | System Settings → Privacy & Security → Accessibility → enable *Mattermost*. Required for push-to-talk and key capture (`globalKeysPermission: 'denied'` until granted). Plugins can call `desktopAPI.bufy.openAccessibilitySettings()`. |
| macOS | **Screen Recording** | Privacy & Security → Screen Recording. Required for screen sharing (and window enumeration for the share border). Asked on first share. |
| macOS | Microphone / Camera | Asked on first use (Info.plist strings are upstream's). |
| macOS | after a rebuild | Ad-hoc signed apps get a new identity for every build: remove the old *Mattermost* entries (−) in Accessibility/Screen Recording and re-add the app, otherwise macOS keeps showing it as enabled but denies it. |
| Linux | X11 or Wayland | **X11**: native hook, nothing to do. **Wayland**: push-to-talk and shortcuts go through xdg-desktop-portal (KDE Plasma, GNOME 48+): the system may ask once to confirm the shortcuts, and the user can change the keys in the system settings (see [wayland.md](wayland.md)). Without a GlobalShortcuts portal `globalKeys` is `false` and plugins should use in-window keys (or log in to an X11/Xorg session). Screen sharing itself works on Wayland through the portal. |
| Linux | `.desktop` file | Wayland shortcuts are remembered per app id `com.Mattermost.Desktop`. The deb/rpm install the `.desktop` file; for the AppImage/tar.gz the app writes a hidden one to `~/.local/share/applications/` on first use ([wayland.md](wayland.md#app-id-so-the-compositor-remembers-the-keys)). |
| Linux | tray | Needs a StatusNotifier/AppIndicator host (GNOME: the *AppIndicator* extension) for tray status. |
| Windows | – | No permission prompts. Push-to-talk is not delivered while an *elevated* (run-as-administrator) window has focus. Exclusive-fullscreen games hide the share border. |

## Updates and data

The in-app update notifier is disabled (it would point to stock releases). To update: build/install a newer version of this fork.
Data directory = stock app's (`productName` and `appId` are unchanged on purpose, see [README.md](README.md#naming--coexistence)).

## Windows packages built in Docker: known limitation

`windows-focus-assist` (detects Windows *Focus Assist*/Do-Not-Disturb) is a C++ add-on that only compiles with MSVC on Windows, so a package built
on Linux cannot contain it. The app tolerates this (try/catch in `dnd-windows.ts`): notifications work, only the *Focus Assist* check is skipped.
For a fully upstream-equivalent Windows build, run `npm ci && npm run package:windows-zip` on a Windows machine. The other
Windows add-ons (`registry-js`, `koffi`, `uiohook-napi`) are prebuilt N-API/FFI binaries and are included.

## Troubleshooting

- *Podman: permission denied on the volume*: SELinux hosts need `:Z` (the script adds it for Podman).
- *`npm ci` fails on `mmjstool`*: it is a GitHub git dependency; the container needs access to github.com (https).
- *Build is slow the first time*: ~5-10 min (downloads + xz/7z compression). Repeated builds reuse the volumes.
- *"cannot find path for dependency @koromix/koffi-…"* warnings are harmless (only the target platform's package is shipped).
- Smoke-test a Linux build headlessly: `xvfb-run -a node scripts/bufy-smoke.js <extracted-app>/com.Mattermost.Desktop <extracted-app>/resources/app.asar`
  (see the script header).
