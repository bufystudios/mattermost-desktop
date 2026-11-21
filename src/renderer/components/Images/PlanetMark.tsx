// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: the planet-mining mark (planet with a wedge cut out, glowing core, station on a tether).
// Simplified from planet-mining/assets/branding/mark.svg; coordinates are kept from that 1024 px source.

import React from 'react';

type Props = {
    width?: number;
    height?: number;

    /** Prefix for gradient/mask ids; must be unique per instance on the same page. */
    idPrefix?: string;

    /** Optional class names so callers (e.g. the loading animation) can animate parts of the mark. */
    className?: string;
    coreClassName?: string;
    stationClassName?: string;
}

const WEDGE = 'M512 640 L271.6 399.6 A340 340 0 0 1 752.4 399.6 Z';

const PlanetMark = ({
    width = 28,
    height = 28,
    idPrefix = 'PlanetMark',
    className,
    coreClassName,
    stationClassName,
}: Props) => {
    const id = (name: string) => `${idPrefix}__${name}`;
    const url = (name: string) => `url(#${id(name)})`;
    return (
        <svg
            className={className}
            width={width}
            height={height}
            viewBox='132 236 760 760'
            xmlns='http://www.w3.org/2000/svg'
        >
            <defs>
                <radialGradient
                    id={id('surface')}
                    cx='34%'
                    cy='30%'
                    r='80%'
                >
                    <stop
                        offset='0'
                        stopColor='#a9b6c8'
                    />
                    <stop
                        offset='0.35'
                        stopColor='#5f6c82'
                    />
                    <stop
                        offset='0.75'
                        stopColor='#252d3d'
                    />
                    <stop
                        offset='1'
                        stopColor='#10141d'
                    />
                </radialGradient>
                <radialGradient
                    id={id('core')}
                    cx='512'
                    cy='640'
                    r='74'
                    gradientUnits='userSpaceOnUse'
                >
                    <stop
                        offset='0'
                        stopColor='#ffffff'
                    />
                    <stop
                        offset='0.25'
                        stopColor='#fff2c2'
                    />
                    <stop
                        offset='0.55'
                        stopColor='#ffb347'
                    />
                    <stop
                        offset='0.85'
                        stopColor='#ff5a2e'
                    />
                    <stop
                        offset='1'
                        stopColor='#c4162c'
                    />
                </radialGradient>
                <radialGradient
                    id={id('magma')}
                    cx='512'
                    cy='640'
                    r='160'
                    gradientUnits='userSpaceOnUse'
                >
                    <stop
                        offset='0.7'
                        stopColor='#ff7a2e'
                    />
                    <stop
                        offset='0.86'
                        stopColor='#d9431f'
                    />
                    <stop
                        offset='1'
                        stopColor='#5a1a12'
                    />
                </radialGradient>
                <linearGradient
                    id={id('yellow')}
                    x1='0'
                    y1='0'
                    x2='0'
                    y2='1'
                >
                    <stop
                        offset='0'
                        stopColor='#ffe066'
                    />
                    <stop
                        offset='1'
                        stopColor='#e0a812'
                    />
                </linearGradient>
                <clipPath id={id('wedge')}>
                    <path d={WEDGE}/>
                </clipPath>
                <mask
                    id={id('noWedge')}
                    maskUnits='userSpaceOnUse'
                    x='132'
                    y='236'
                    width='760'
                    height='760'
                >
                    <rect
                        x='132'
                        y='236'
                        width='760'
                        height='760'
                        fill='#fff'
                    />
                    <path
                        d={WEDGE}
                        fill='#000'
                    />
                </mask>
            </defs>

            {/* planet surface with the wedge removed */}
            <g mask={url('noWedge')}>
                <circle
                    cx='512'
                    cy='640'
                    r='340'
                    fill={url('surface')}
                />
                <g
                    fill='#1b2230'
                    opacity='0.55'
                >
                    <ellipse
                        cx='300'
                        cy='560'
                        rx='38'
                        ry='30'
                    />
                    <ellipse
                        cx='380'
                        cy='770'
                        rx='54'
                        ry='40'
                    />
                    <ellipse
                        cx='640'
                        cy='860'
                        rx='34'
                        ry='24'
                    />
                    <ellipse
                        cx='760'
                        cy='640'
                        rx='26'
                        ry='34'
                    />
                </g>
            </g>

            {/* cut face: layers, cold to hot */}
            <g clipPath={url('wedge')}>
                <circle
                    cx='512'
                    cy='640'
                    r='340'
                    fill='#9aa8bd'
                />
                <circle
                    cx='512'
                    cy='640'
                    r='298'
                    fill='#2a2829'
                />
                <circle
                    cx='512'
                    cy='640'
                    r='252'
                    fill='#9a5630'
                />
                <circle
                    cx='512'
                    cy='640'
                    r='206'
                    fill='#2c3340'
                />
                <circle
                    cx='512'
                    cy='640'
                    r='160'
                    fill={url('magma')}
                />
                <circle
                    cx='512'
                    cy='640'
                    r='116'
                    fill='#e0283a'
                />
            </g>
            <g
                stroke='#ffb347'
                strokeWidth='8'
                strokeLinecap='round'
                opacity='0.85'
            >
                <path d='M512 640 L271.6 399.6'/>
                <path d='M512 640 L752.4 399.6'/>
            </g>

            {/* exposed core */}
            <circle
                className={coreClassName}
                cx='512'
                cy='640'
                r='74'
                fill={url('core')}
            />

            {/* tether and hanging station */}
            <rect
                x='505'
                y='236'
                width='14'
                height='200'
                fill='#eef3fb'
            />
            <g className={stationClassName}>
                <g transform='translate(512 452)'>
                    <path
                        d='M-16 22 L16 22 L0 60 Z'
                        fill='#cfd6e2'
                    />
                    <path
                        d='M-72 -6 L-56 -26 L56 -26 L72 -6 L58 24 L-58 24 Z'
                        fill={url('yellow')}
                        stroke='#1a1d26'
                        strokeWidth='8'
                        strokeLinejoin='round'
                    />
                    <rect
                        x='-50'
                        y='-4'
                        width='100'
                        height='10'
                        rx='4'
                        fill='#1a1d26'
                    />
                    <rect
                        x='-12'
                        y='-42'
                        width='24'
                        height='18'
                        rx='4'
                        fill='#2a2f3c'
                    />
                </g>
            </g>
        </svg>
    );
};

export default PlanetMark;
