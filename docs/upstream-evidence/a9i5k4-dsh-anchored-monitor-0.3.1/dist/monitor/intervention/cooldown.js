/**
 * 冷却管理: 每个干预级别独立冷却, 冷却期内不重复触发同级别
 */
export class CooldownManager {
    cooldowns;
    lastSent = {};
    constructor(cooldowns) {
        this.cooldowns = cooldowns;
    }
    remaining(level, now) {
        const last = this.lastSent[level];
        if (last === undefined)
            return 0;
        return Math.max(0, this.cooldowns[`${level}_ms`] - (now - last));
    }
    isReady(level, now) {
        return this.remaining(level, now) <= 0;
    }
    markSent(level, now) {
        this.lastSent[level] = now;
    }
    /** 各级别剩余冷却毫秒(供仪表盘展示) */
    snapshot(now) {
        return {
            L1: this.remaining('L1', now),
            L2: this.remaining('L2', now),
            L3: this.remaining('L3', now)
        };
    }
}
