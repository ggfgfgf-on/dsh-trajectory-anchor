# DSH 兼容性声明与一次性 Profile 验收证据

本文件是 `package.json` 中 `engines.dsh`、`dsh.compatibility.dshReleases`、
`dsh.compatibility.dshOperations` 三类声明的证据来源，对应 DSH STORE 修复单
[#1372](https://github.com/AI-Scarlett/DSH-Store/issues/1372)：提交时仓库被识别为
多包仓库（`SUBMISSION_PACKAGE_AMBIGUOUS`），且 root manifest 没有对官方最新三版本
给出精确 `compatible` 声明，候选因此被剪除。

## 1. 声明内容（v0.5.2 manifest）

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `engines.node` | `>=22.19` | Node.js 运行下限声明 |
| `engines.dsh` | `>=0.2.0-rc.2 <0.3.0` | DSH 源码兼容范围声明 |
| `dsh.compatibility.dshReleases` | 下方 6 个版本 = `compatible` | 逐版本精确声明 |
| `dsh.compatibility.dshOperations` | install / start / uninstall = `passed`，rollback = `unknown` | 第 3 节实测结果 |

范围与逐版本记录一致（`>=0.2.0-rc.2 <0.3.0` 覆盖全部 6 个声明版本）；未列出的版本
保持 `unknown` —— 既不写成兼容，也不写成不兼容。`compatible` 是**来源兼容声明**，
不等于真实 Profile 的运行/功能验收，见第 4 节边界。

## 2. 复核窗口

- 修复单列出：`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`；
- 本文件生成时（2026-10-17）的官方窗口，用 DSH STORE 自己的
  `officialDshReleaseWindow` 策略（`@deepseek-ai/dsh` npm `dist-tags`/`versions`
  + `deepseek-ai/deepseek-harness` GitHub Releases）解析为：
  `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`；
- 两批共 6 个版本全部实测，没有抽样外推。

## 3. 一次性 Profile 验收（install / start / uninstall）

- 环境：Windows，Node.js v24.19.0；运行时为各版本官方 npm 包
  （`npm install --prefix <dsh-prefix> @deepseek-ai/dsh@<version>`）。
- 每个版本都在**新建的临时 `DSH_HOME`** 中执行；真实 `~/.dsh` Profile 不参与、
  不被读写。被测源码固定为本次提交的完整 Git 树。
- 每个版本执行 6 步：

1. 基线：`dsh --profile web --dump-config`
2. 安装：`dsh plugin --profile web add --ignore-scripts
   --config.auto-install-peers=false file:<fixed-checkout>`
3. 装载：`dsh --profile web --dump-config`，必须出现
   `id: trajectory-anchor / name: '@dsh-ext/trajectory-anchor'`
4. 启动：`dsh web --no-open --port <free>`，等到 `dsh web: http://...`，
   且 `GET /` 返回 2xx/3xx
5. 卸载：`dsh plugin --profile web remove @dsh-ext/trajectory-anchor`
6. 复原：`dsh --profile web --dump-config` 必须与第 1 步输出逐字节一致

### 结果

| DSH 版本 | install | start（boot + HTTP 303） | uninstall（基线逐字节复原） | rollback |
| --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | passed | passed | passed | unknown |
| 0.2.1-alpha.1 | passed | passed | passed | unknown |
| 0.2.1-alpha.2 | passed | passed | passed | unknown |
| 0.2.1-alpha.3 | passed | passed | passed | unknown |
| 0.2.1-alpha.4 | passed | passed | passed | unknown |
| 0.2.1-alpha.5 | passed | passed | passed | unknown |

被测工件（6 个版本一致，均在 `<fixed-checkout>` 快照中取哈希）：

| 文件 | SHA-256 |
| --- | --- |
| `index.js` | `5086d85bbf41f375654cd64a31a9c0e1c677c5aa3e2b2117aee82b06ad33fdad` |
| `cordis.patch.yml` | `5f3ff9f847bf99dfdf3da0a2c18b3916a12bf9551a738df75d1f0e67052e9374` |
| `package.json` | `a39151edf2a5b6f039c7b0e8ff26efab47ca6e8180da759e7ba00ff96d9fa920` |

原始结果（每步退出码、耗时、stdout/stderr 尾部；会话 token 与机器绝对路径已脱敏）
在 [`store-evidence/`](store-evidence/)：`e3-<version>.json`。
复跑脚本：[`store-evidence/run-e3-matrix.mjs`](store-evidence/run-e3-matrix.mjs)。

## 4. 边界（不把低层证据冒充高层验收）

- `start` = 组合装载 + Web 进程启动 + HTTP 响应；**没有**调用 LLM 跑完整会话，
  因此不等于功能、行为或效果验收；
- `rollback` 未执行，保持 `unknown`；不因为 install / uninstall 通过就写成 `passed`；
- 未做独立安全审计；权限与已知风险见 README `## Permissions and known risks`；
- `dshReleases: compatible` 只是 manifest 的逐版本来源声明，不替代真实 Profile 的
  运行验收，也不替代商城侧的安装资格判定。

## 5. 重新提交：monorepo 的 `Plugin path`

`docs/upstream-evidence/` 保存第三方快照（内含各自的 `package.json`），所以自动预检
会把仓库识别为多包仓库。按 DSH STORE 指引**不需要删除其他包**，重新提交时二选一：

- 申请单 `Plugin path` 填 `.`；或
- 仓库地址填 `https://github.com/ggfgfgf-on/dsh-trajectory-anchor/tree/main/`，
  明确指向根包。

预检随后直接读取根 `package.json`，并用本文件第 1 节的逐版本声明覆盖当前
“最新三版本窗口”。

## 6. 复现

```powershell
# <dsh-prefix>: 对应官方版本的 npm 安装前缀；<fixed-checkout>: 固定 Commit 的完整树
# <evidence-dir>: 输出目录（不要在真实 DSH_HOME 下运行）
node docs/store-evidence/run-e3-matrix.mjs `
  --cli "<dsh-prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js" `
  --plugin "<fixed-checkout>" --label "<version>" --work "<evidence-dir>"
```

脚本自建临时 `DSH_HOME` / `DSH_AGENTS_HOME`，剥除环境中的 token 类变量，
输出脱敏结果 JSON；任一断言失败即以非零退出码结束。

Prepared: 2026-10-17.
