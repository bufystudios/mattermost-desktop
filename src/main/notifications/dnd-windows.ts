// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {getFocusAssist, isPriority} from 'windows-focus-assist';

/**
    -2: NOT_SUPPORTED,
    -1: FAILED,
    0: Off,
    1: PRIORITY_ONLY,
    2: ALARMS_ONLY
*/
function getWindowsDoNotDisturb() {
    if (process.platform !== 'win32') {
        return false;
    }

    // [bufy] Windows packages cross-built in Docker/Linux cannot compile this addon; fail soft instead of
    // breaking every notification. See docs/bufy/BUILD.md.
    let focusAssistValue;
    try {
        focusAssistValue = getFocusAssist().value;
    } catch {
        return false;
    }
    switch (focusAssistValue) {
    case 2:
        return true;
    case 1:
        return !(isPriority('Mattermost.Desktop').value);
    default:
        return false;
    }
}

export default getWindowsDoNotDisturb;
