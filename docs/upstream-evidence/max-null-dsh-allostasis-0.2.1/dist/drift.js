/**
 * 思考语言漂移判定。
 *
 * 判据是**英文功能词密度** = 英文功能词数 / 英文词数，并要求英文词数达到门槛。
 * 实测依据（2026-09-20，会话 `session-3bf8bcfb`，156 条 `assistant/message`）：
 * 中文期中位密度 0.012、英文期中位 0.273–0.389，阈值 0.15 两群完全分离。词数门槛
 * 是必需的——中文期唯一的越线点（密度 0.192）只有 26 个英文词，小样本让密度失真。
 *
 * 另外两个看起来更直观的指标不可用：
 *   · 中文字符占比：中文思考本来就大量夹英文标识符，实测中文期只有 0.19–0.37，
 *     与英文期的 0.00–0.15 区分度太小。
 *   · 最长连续英文游程：中文思考引用一段代码就会把它顶到 43，它测的是「引用了多长
 *     的代码」，不是「用什么语言思考」。
 *
 * 设计出处：`docs/设计/2026-09-20-应变-设计方案.md` §4.3
 * @module @max-null/dsh-allostasis/drift
 */
/** 英文功能词：中文思考引用英文标识符时不会带这些词。 */
const FUNC_WORDS = new Set(('the is are was were and or but to of in that this with for it as be not if on at by from an a ' +
    'we i you they have has will can should would there which when what how so then than also all ' +
    'one two no yes do does did its their our my his her them these those been being more most some ' +
    'any each both into over after before while because however thus therefore instead about only ' +
    'just even still yet first second next last new same other such per here where who whose must ' +
    'may might shall').split(' '));
/** 功能词密度达到此值即判为漂移；中文期中位 0.012、英文期中位 0.273 以上。 */
export const DRIFT_THRESHOLD = 0.15;
/** 判定所需的最少英文词数；低于此值只报数不判定，避免小样本把密度算飞。 */
export const MIN_WORDS = 50;
/** 统计一条思考文本的各量。空文本返回全零。 */
export function measureThinking(text) {
    const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
    const funcWords = words.filter(word => FUNC_WORDS.has(word.toLowerCase())).length;
    return {
        chars: text.length,
        cjk,
        cjkRatio: text.length === 0 ? 0 : cjk / text.length,
        words: words.length,
        funcWords,
        funcDensity: words.length === 0 ? 0 : funcWords / words.length,
    };
}
/**
 * 对一次测量下判定。
 * @param metrics - 量化结果。
 * @param threshold - 功能词密度阈值；缺省用 {@link DRIFT_THRESHOLD}。
 * @returns 三态判定。
 */
export function verdict(metrics, threshold = DRIFT_THRESHOLD) {
    if (metrics.words < MIN_WORDS)
        return 'insufficient';
    return metrics.funcDensity >= threshold ? 'drift' : 'chinese';
}
