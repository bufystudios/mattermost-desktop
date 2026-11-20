// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Bufy fork: tiny per-key minimum-interval rate limiter.

export class RateLimiter {
    private last = new Map<string, number>();

    private minIntervalMs: number;
    private now: () => number;

    constructor(minIntervalMs: number, now: () => number = Date.now) {
        this.minIntervalMs = minIntervalMs;
        this.now = now;
    }

    /** Returns true if the call may proceed. */
    allow = (key: string | number): boolean => {
        const k = String(key);
        const t = this.now();
        const prev = this.last.get(k);
        if (prev !== undefined && t - prev < this.minIntervalMs) {
            return false;
        }
        this.last.set(k, t);
        return true;
    };

    forget = (key: string | number) => {
        this.last.delete(String(key));
    };

    clear = () => this.last.clear();
}
