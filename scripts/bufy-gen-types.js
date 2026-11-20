// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let src = fs.readFileSync(path.join(root, 'src/main/bufy/shared.ts'), 'utf8');

src = src.
    replace(/^\/\/ (Copyright|See LICENSE|Bufy fork:|This file must stay free).*\n/gm, '').
    replace(/export const BUFY_CHANNELS = \{[\s\S]*?\} as const;\n\n/, '').
    replace(/export const LIMITS = \{[\s\S]*?\};\n/, '').
    replace(/export const BUFY_API_VERSION = '([^']+)';/, 'export declare const BUFY_API_VERSION: \'$1\';').
    replace(/^\n+/, '').
    trimEnd();

const header = `// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Types for \`window.desktopAPI.bufy\` (Bufy fork of the Mattermost desktop app).
// GENERATED from src/main/bufy/shared.ts by scripts/bufy-gen-types.js - do not edit by hand.
// Copy this file into a plugin or \`import type\` from it.
//
// Feature detection (works unchanged on the stock app, where \`bufy\` is simply undefined):
//
//   const bufy = (window as BufyWindow).desktopAPI?.bufy;
//   if (bufy) { const caps = await bufy.getCapabilities(); /* ... */ }

`;

const out = `${header}${src}\n\nexport type BufyWindow = Window & {desktopAPI?: {bufy?: BufyAPI}};\n`;
fs.writeFileSync(path.join(root, 'docs/bufy/desktop-api-bufy.d.ts'), out);
console.log('wrote docs/bufy/desktop-api-bufy.d.ts');
