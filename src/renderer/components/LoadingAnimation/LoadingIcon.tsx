// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react';

import PlanetMark from 'renderer/components/Images/PlanetMark';

/**
 * Bufy fork: the loading logo is the planet-mining mark; LoadingAnimation.scss animates its parts
 * (intro, then a pulsing core and a bobbing station while loading).
 */
function LoadingIcon() {
    return (
        <PlanetMark
            idPrefix='LoadingAnimation__mark'
            width={104}
            height={104}
            className='LoadingAnimation__mark'
            coreClassName='LoadingAnimation__core'
            stationClassName='LoadingAnimation__station'
        />
    );
}

export default LoadingIcon;
