# 上游证据快照（upstream evidence）

本目录是 `docs/community-reference-matrix.md` 的**一手证据**：对照矩阵里每一行"上游做法"
都指向这里的文件，可离线复核，不需要网络。

## 抓取方式（可复现）

```powershell
# npm 侧（需要代理时先设置 HTTP_PROXY/HTTPS_PROXY）
npm pack @argszero/cordis-plugin-preset-tool-filter@0.2.0 --pack-destination <tmp>
npm pack @a9i5k4/dsh-anchored-monitor@0.3.1        --pack-destination <tmp>
npm pack @max-null/dsh-allostasis@0.2.1            --pack-destination <tmp>
tar -xzf <pkg>.tgz -C <dir>      # 只归档关键文件（见下）

# GitHub 侧（raw）
curl -s -o shared_tool-bootstrap.mjs https://raw.githubusercontent.com/xiaobright/dsh-anchored-standard/HEAD/shared/tool-bootstrap.mjs
curl -s -o shared_context-gate.mjs   https://raw.githubusercontent.com/xiaobright/dsh-anchored-standard/HEAD/shared/context-gate.mjs
curl -s -o test_tool-bootstrap.test.mjs https://raw.githubusercontent.com/xiaobright/dsh-anchored-standard/HEAD/test/tool-bootstrap.test.mjs
curl -s -o shared_zero-tool-bootstrap.mjs https://raw.githubusercontent.com/xiaobright/dsh-anchored-standard/HEAD/shared/zero-tool-bootstrap.mjs
curl -s -o shared_anchor-turn.mjs    https://raw.githubusercontent.com/xiaobright/dsh-anchored-standard/HEAD/shared/anchor-turn.mjs
```

## 版本与来源

| 目录 / 文件 | 来源 | 版本 |
|---|---|---|
| `argszero-cordis-plugin-preset-tool-filter-0.2.0/` | npm `@argszero/cordis-plugin-preset-tool-filter` | 0.2.0 |
| `a9i5k4-dsh-anchored-monitor-0.3.1/` | npm `@a9i5k4/dsh-anchored-monitor` | 0.3.1 |
| `max-null-dsh-allostasis-0.2.1/` | npm `@max-null/dsh-allostasis` | 0.2.1 |
| `xiaobright-dsh-anchored-standard/` | GitHub `xiaobright/dsh-anchored-standard` @ HEAD | HEAD（抓取于 2026-10-01） |

未在 npm 上找到的引用：`we-need-ds`（GitHub `YixuAn-13/we-need-ds`，Claude Code 插件，
按轮类型切换工具面）与 `dsh-anchored-standard` 本身（GitHub-only）。矩阵中涉及这两项的
判定**只到仓库描述/README 级**，已在矩阵第四节标为"证据深度"未解决项。

## 抓取时的关键观察（供复核）

- `argszero/lib/index.js:26-30` 明确记载：被 restrict 掉的名字"**survives `restrict()` unthrown,
  leaves `schemas()`/`get()`, and dispatches as `UNKNOWN_TOOL`**"——这正是我们历史上
  `unknown tool` 空转的机制来源（15 个会话可见）。
- `shared/tool-bootstrap.mjs` 注释里记录了同一个坑的修法：`promoteOn:'tool-call'`
  "**can trap a session in bootstrap forever** … the `'either'` default **removes that trap**"。
- `shared/context-gate.mjs:61-63` 写明 fail-open 原则："both filters degrade to 'keep everything'
  on their own failures — **a gate bug must never eat the user's context**"。
