/**
 * 思考重复度判定（退化检测的判据）。
 *
 * 判据 = 单条推理按换行与中英句读切分后，**出现 ≥3 次的单元占全部单元的比例**，
 * 并要求连续若干步越线才触发。
 *
 * 实测依据（2026-09-28，会话 `session-fabc21b2`，19 轮 416 条助手消息）：
 * 正常期重复率 0%–35%、退化期 48%–92%，隔离带很宽。阈值取 50% 落在这份单会话样本
 * 两端的中点附近，**不是标定结果**——它是第一期可用的起点，标定留给数据积累
 * （设计方案 §4.2 与 §五）。
 *
 * 连续 N 步是必需的：正常期也会出现单次抖动（实测峰值 35%），只按单步触发会让误报
 * 跟着抖动走。代价是延迟——按同一份数据回放，触发会落在 t11/s2 而不是 t10/s44，
 * 晚约 3 步（中间夹了一个 48%，低于阈值、计数归零）。
 *
 * 为什么不用推理长度当辅助判据：退化期的单条推理并不特别长（实测 1,000–2,600
 * 字符），长度不区分两群；重复率本身已经把「这段内容有多少信息」量化了。
 *
 * 设计出处：`docs/设计/2026-09-28-应变二期-退化检测与自动干预.md` §四
 * @module @max-null/dsh-allostasis/repetition
 */
/** 单元重复达到此次数才计入「重复单元」。 */
export const REPEAT_MIN_COUNT = 3;
/** 判定所需的最少单元数；低于此值只报数不判定，避免小样本把比例算飞。 */
export const MIN_UNITS = 12;
/** 重复率判定阈值——起点值，非标定值。 */
export const REPETITION_THRESHOLD = 0.5;
/** 触发所需的连续越线步数。 */
export const CONSECUTIVE_STEPS = 2;
/** 切分单元用的分隔符：换行与中英句读。 */
const UNIT_SEPARATOR = /[\n。！？]/;
/**
 * 统计一条思考文本的重复度。空文本返回全零。
 *
 * 单元按 `UNIT_SEPARATOR` 切分并去掉空白，因此纯空行的段落不参与统计。
 * `top` 只收达到 `REPEAT_MIN_COUNT` 的单元，最多 5 条，同次数按单元字典序稳定排序。
 * @param text - 推理原文。
 * @returns 量化结果。
 */
export function measureRepetition(text) {
    const units = text.split(UNIT_SEPARATOR)
        .map(part => part.trim())
        .filter(part => part !== '');
    const counts = new Map();
    for (const unit of units)
        counts.set(unit, (counts.get(unit) ?? 0) + 1);
    let repeated = 0;
    const frequent = [];
    for (const [unit, count] of counts) {
        if (count < REPEAT_MIN_COUNT)
            continue;
        repeated += count;
        frequent.push({ unit, count });
    }
    frequent.sort((a, b) => b.count - a.count || a.unit.localeCompare(b.unit));
    return {
        units: units.length,
        repeated,
        ratio: units.length === 0 ? 0 : repeated / units.length,
        top: frequent.slice(0, 5),
    };
}
/**
 * 对一次测量下判定。
 *
 * 单元数不足 `MIN_UNITS` 时返回 `insufficient`——**不下结论**。调用方据此决定该步
 * 既不算越线也不算清白（见 `trackLoop`）。
 * @param metrics - 量化结果。
 * @param threshold - 重复率阈值；缺省用 {@link REPETITION_THRESHOLD}。
 * @returns 三态判定。
 */
export function repetitionVerdict(metrics, threshold = REPETITION_THRESHOLD) {
    if (metrics.units < MIN_UNITS)
        return 'insufficient';
    return metrics.ratio >= threshold ? 'loop' : 'normal';
}
/**
 * 推进连续越线计数，并判定本次是否触发。
 *
 * **状态不跨 turn 延续**：新一轮的第一条推理重新起算。turn 是用户可感知的边界，
 * 而且实测里退化在同一个 turn 内就已连成片（t10 的 44%–64% 全在一轮内），跨轮累加
 * 只会让触发更晚。
 *
 * `insufficient` 的样本**保持计数不变**：它既不是越线也不是清白，算作清零会让
 * 「推理偶尔写得很短」反复推迟触发。
 *
 * @param state - 上一次的状态；首次调用传 `undefined`。
 * @param turn - 产出该思考的 turn。
 * @param verdict - 该步的判定。
 * @param required - 触发所需的连续越线步数；缺省用 {@link CONSECUTIVE_STEPS}。
 * @returns `state` 为推进后的新状态；`fire` 为本次是否达到触发条件。
 */
export function trackLoop(state, turn, verdict, required = CONSECUTIVE_STEPS) {
    const current = state ?? { consecutive: 0, lastTurn: Number.NaN };
    const base = current.lastTurn === turn ? current.consecutive : 0;
    if (verdict === 'insufficient')
        return { state: { consecutive: base, lastTurn: turn }, fire: false };
    const consecutive = verdict === 'loop' ? base + 1 : 0;
    return { state: { consecutive, lastTurn: turn }, fire: consecutive >= required };
}
