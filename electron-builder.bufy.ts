// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/* eslint-disable import/no-commonjs, no-template-curly-in-string */

// Bufy fork: electron-builder overrides on top of the unchanged upstream `electron-builder.ts`.
//
//   electron-builder --config electron-builder.bufy.ts --linux deb rpm appimage tar.gz --x64
//
// Everything here is unsigned. See docs/bufy/README.md and docs/bufy/BUILD.md.

const base = require('./electron-builder.ts');

const ALL_PREBUILDS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-loong64', 'linux-x64', 'win32-arm64', 'win32-x64'];

// uiohook-napi ships N-API prebuilds for every platform; only keep the ones of the target OS.
const prebuildExcludes = (keepPrefix: string) => ALL_PREBUILDS.
    filter((p) => !p.startsWith(keepPrefix)).
    map((p) => `!**/node_modules/uiohook-napi/prebuilds/${p}/**`);

const bufyFiles = [
    'node_modules/uiohook-napi/package.json',
    'node_modules/uiohook-napi/LICENSE',
    'node_modules/uiohook-napi/dist/**/*',
    'node_modules/uiohook-napi/prebuilds/**/*.node',
    'node_modules/node-gyp-build/**/*',
];

// keep upstream's `{from: 'dist'}` file set last
const baseFiles: unknown[] = base.files;
const distSet = baseFiles.filter((f) => typeof f !== 'string');
const stringFiles = baseFiles.filter((f) => typeof f === 'string');

const config = {
    ...base,

    // Same productName/data dir as the stock app on purpose (replace in place); only the package name differs
    // so deb/rpm can declare Conflicts/Replaces/Provides against the stock package.
    extraMetadata: {
        ...base.extraMetadata,
        name: 'mattermost-desktop-bufy',
    },
    artifactName: 'mattermost-desktop-bufy-${version}-${os}-${arch}.${ext}',
    files: [...stringFiles, ...bufyFiles, ...distSet],
    asarUnpack: [...base.asarUnpack, './node_modules/uiohook-napi/prebuilds/**/*.node'],

    linux: {
        ...base.linux,
        target: ['deb', 'rpm', 'appimage', 'tar.gz'], // flatpak needs flatpak-builder + runtimes, not supported here
        files: prebuildExcludes('linux-'),
    },
    deb: {
        ...base.deb,
        artifactName: 'mattermost-desktop-bufy_${version}-1_${arch}.${ext}',
        depends: [...base.deb.depends, 'libxt6'], // uiohook-napi links libXt
        fpm: ['--conflicts', 'mattermost-desktop', '--replaces', 'mattermost-desktop', '--provides', 'mattermost-desktop'],
    },
    rpm: {
        ...base.rpm,
        artifactName: 'mattermost-desktop-bufy-${version}.${arch}.${ext}',
        fpm: [...base.rpm.fpm, '--depends', 'libXt', '--conflicts', 'mattermost-desktop', '--replaces', 'mattermost-desktop', '--provides', 'mattermost-desktop'],
    },

    win: {
        ...base.win,
        target: ['nsis', 'zip'], // MSI needs WiX, which is not available in the Linux/Wine builder
        files: prebuildExcludes('win32-'),
        azureSignOptions: null,
    },
    nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        deleteAppDataOnUninstall: false, // same data dir as the stock app: never touch it
        artifactName: 'mattermost-desktop-bufy-${version}-${os}-${arch}-setup.${ext}',
    },

    mac: {
        ...base.mac,
        target: ['zip', 'dmg'],
        files: prebuildExcludes('darwin-'),

        // unsigned; scripts/bufy-build-mac.sh ad-hoc signs the .app so it runs on Apple Silicon
        identity: null,
        hardenedRuntime: false,
        gatekeeperAssess: false,
        notarize: false,
    },
};

module.exports = config;
