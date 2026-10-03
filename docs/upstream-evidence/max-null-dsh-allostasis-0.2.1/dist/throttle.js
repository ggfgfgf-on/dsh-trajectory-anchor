/**
 * 提醒注入的节流：**同一 turn 至多一次**。
 *
 * 实测（2026-09-21，会话 `session-502b3e2b`，记录见设计方案 §12.4）：漂移持续时**每个
 * step 都会判定为漂移**，于是同一个 turn 内会连着注入多条几乎一样的提醒——观测到 3 连注，
 * 其中 turn 1 之内就有 2 条。第 2 条起信息量已经递减：模型上一个 step 刚读过同一句话。
 *
 * 所以收紧到「同一 turn 至多一次」：turn 是用户能感知的自然边界，重试留到下一轮，
 * 而不是在一步之内反复催促。上限写成常数而不是配置项，是因为**没有数据支撑别的取值**；
 * 等无对抗的自然漂移样本出来，再决定要不要放宽（设计方案 §八 第 9 条）。
 *
 * 退化提醒复用同一契约、独立一份状态：两类提醒的判据无关，共用状态会让先说的那类
 * 把另一类挡在门外。
 * @module @max-null/dsh-allostasis/throttle
 */
/** 同一 turn 内的提醒注入上限。 */
export const MAX_PER_TURN = 1;
/**
 * 判定本次是否放行，并推进状态。
 *
 * `sampledTurn` 是**产出那段被判定异常的输出的 turn**，不是当前 turn——提醒的措辞
 * 指向「你上一步在想什么」，节流的计次也应当跟着它走。
 * @param state - 上一次的状态；首次调用传 `undefined`。
 * @param sampledTurn - 产出该输出的 turn。
 * @returns 放行时返回新状态；应当跳过时返回 `undefined`。
 */
export function admitPerTurn(state, sampledTurn) {
    const current = state ?? { lastTurn: Number.NaN, inTurn: 0, count: 0 };
    const inTurn = current.lastTurn === sampledTurn ? current.inTurn : 0;
    if (inTurn >= MAX_PER_TURN)
        return undefined;
    return { lastTurn: sampledTurn, inTurn: inTurn + 1, count: current.count + 1 };
}
