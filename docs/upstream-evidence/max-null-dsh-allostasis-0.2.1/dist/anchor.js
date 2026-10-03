/**
 * 锚定文本的组装。
 *
 * 单独成文件而不是留在入口里：入口 `index.ts` 要导入 `@deepseek-ai/dsh-llm` 的
 * `createUserMessage`（运行时依赖，由宿主 profile 提供），而测试环境只装了 npm 上的
 * 部分 DSH 包——放在同一个文件里会让纯文本逻辑的测试连带去解析 DSH 运行时。
 * @module @max-null/dsh-allostasis/anchor
 */
/**
 * 组装锚定文本。
 *
 * 刻意点明「引用英文标识符是正常的」：判据只看英文语法结构，若不说明，模型可能为了
 * 规避提醒而不敢写代码符号，那会伤到正常工作。
 * 第二次起带上序号并改口径（「你仍然在用英文思考」）：节流之后，同一条提醒仍可能在
 * 后续 turn 重复出现，措辞一成不变的话，重复的那几条就是纯噪音。
 * @param turn - 产出该思考的 turn。
 * @param step - 产出该思考的 step。
 * @param metrics - 那一步思考的量化结果。
 * @param reminder - 这是本会话第几次提醒；默认 1。
 * @returns 一条锚定消息的正文。
 */
export function anchorText(turn, step, metrics, reminder = 1) {
    const where = `（turn ${turn} step ${step}）的思考是英文的`
        + `（英文功能词密度 ${metrics.funcDensity.toFixed(2)}，共 ${metrics.words} 个英文词）。`;
    const head = reminder > 1
        ? `⚠️ 语言漂移提醒（应变，第 ${reminder} 次）：你仍然在用英文思考——上一步${where}`
        : `⚠️ 语言漂移提醒（应变）：你上一步${where}`;
    return head
        + '现在回到中文思考。注意：读代码时引用英文标识符是正常的，'
        + '这里判定的是整句英文——出现英文语法结构才算漂移。';
}
