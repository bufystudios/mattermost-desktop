// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: planet-mining lockup (mark + "PLANET MINING" wordmark) instead of the Mattermost logo.
// The words are Russo One glyphs converted to paths, so no web font is needed.

import React from 'react';

import PlanetMark from './PlanetMark';

type Props = {
    width?: number;
    height?: number;
}

const PLANET_PATH = 'M0.9 0H7.2Q8.78 0 9.49 0.71Q10.2 1.43 10.2 3V4.5Q10.2 6.08 9.49 6.79Q8.78 7.5 7.2 7.5H3.6V10.5H0.9ZM7.5 3Q7.5 2.1 6.6 2.1H3.6V5.4H6.6Q7.5 5.4 7.5 4.5ZM15.05 8.4H20.52V10.5H12.35V0H15.05ZM24.25 10.5H21.33L25.3 0H28.3L32.27 10.5H29.35L28.68 8.62H24.93ZM25.6 6.68H28L26.8 3.15ZM42.98 10.5H40.12L36.53 4.2V10.5H33.83V0H36.68L40.28 6.3V0H42.98ZM53.9 10.5H45.58V0H53.9V2.1H48.28V4.12H52.7V6.23H48.28V8.4H53.9ZM61 10.5H58.3V2.1H55.15V0H64.15V2.1H61Z';
const MINING_PATH = 'M9.9 4.65 7.8 8.4H5.7L3.6 4.65V10.5H0.9V0H3.75L6.75 5.55L9.75 0H12.6V10.5H9.9ZM20.15 10.5H14.75V8.4H16.1V2.1H14.75V0H20.15V2.1H18.8V8.4H20.15ZM31.45 10.5H28.6L25 4.2V10.5H22.3V0H25.15L28.75 6.3V0H31.45ZM39 10.5H33.6V8.4H34.95V2.1H33.6V0H39V2.1H37.65V8.4H39ZM50.3 10.5H47.45L43.85 4.2V10.5H41.15V0H44L47.6 6.3V0H50.3ZM61.9 10.28Q58.39 10.65 55.45 10.65Q53.98 10.65 53.29 9.96Q52.6 9.27 52.6 7.8V3Q52.6 1.43 53.31 0.71Q54.02 0 55.6 0H61V2.1H56.2Q55.3 2.1 55.3 3V7.8Q55.3 8.14 55.5 8.35Q55.7 8.55 56.05 8.55Q57.77 8.55 59.2 8.47V6.3H57.25V4.5H61.9Z';

export default ({
    width = 104,
    height = 28,
}: Props) => (
    <svg
        width={width}
        height={height}
        viewBox='0 0 104 28'
        fill='none'
        xmlns='http://www.w3.org/2000/svg'
    >
        <defs>
            <linearGradient
                id='Logo__heat'
                x1='0'
                y1='0'
                x2='0'
                y2='1'
            >
                <stop
                    offset='0'
                    stopColor='#ffb347'
                />
                <stop
                    offset='0.6'
                    stopColor='#ff6b3d'
                />
                <stop
                    offset='1'
                    stopColor='#e0283a'
                />
            </linearGradient>
        </defs>
        <PlanetMark
            idPrefix='Logo__mark'
            width={28}
            height={28}
        />
        <path
            transform='translate(36 1.5)'
            d={PLANET_PATH}
            fill='var(--center-channel-color)'
        />
        <path
            transform='translate(36 15.5)'
            d={MINING_PATH}
            fill='url(#Logo__heat)'
        />
    </svg>
);
