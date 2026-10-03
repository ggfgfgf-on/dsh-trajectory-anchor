# cordis-plugin-preset-tool-filter

Two uses of one public `tools.restrict()` seam for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), applied per agent scope at `agent/created`:

1. **Per-preset tool allowlist** — [#5786](https://github.com/deepseek-ai/deepseek-harness/discussions/5786)
2. **Per-deployment tool-group opt-out** — [#7080](https://github.com/deepseek-ai/deepseek-harness/discussions/7080)

Both are **plugin-side**, not harness patches: the harness already exposes the mechanism, nothing in the preset
or provider composition calls it.

## Why

Every agent **inherits** the tool registry's global layer and every ancestor layer on its scope chain. Two
consequences:

- **#5786.** Preset composition mounts its rows into a standing ancestor scope and never applies a
  `ToolRestriction`, so a `minimal` agent still inherits every plugin-registered global tool — the model sees a
  catalog far larger than the preset intended.
- **#7080.** A provider that registers a large catalog unconditionally (the computer-use driver: 55 tools,
  ~94 KB / ~23.5k tokens of request prefix in the reporter's environment) has no registration-time knob.
  Disabling the provider removes the capabilities the deployment *does* use; there is no way to drop one group.

`tools.restrict({ allow, deny })` answers both: it masks what the scope **inherits** (global layer + every
ancestor layer) and never the scope's own registrations, so a config-mounted provider's tools can be taken out
of the request prefix — and out of dispatch — while the provider stays mounted.

## Install

```sh
npm install @argszero/cordis-plugin-preset-tool-filter
```

Mount the plugin into your `dsh` profile:

```yaml
# cordis.yml
plugins:
  "@argszero/cordis-plugin-preset-tool-filter":
    groups:
      browser: { names: [cua_driver_native__browser_prepare, cua_driver_native__get_browser_state] }
      recording: { prefix: cua_driver_native__recording }
    disableGroups: [browser, recording]
```

> **Peer dependencies.** The plugin reads `tools` and `agentPresets` at runtime via `ctx.get()`, so
> `@deepseek-ai/dsh-tools` is an optional peer (present in any real harness workspace, absent from a bare
> `@deepseek-ai/cordis` one). The built artifact imports **nothing** at runtime — the `cordis` import is
> type-only — so the peer range is only a compatibility claim, checked in `test/packaging.spec.mjs`.

> **Version pin.** The `@deepseek-ai/dsh-*` `latest` dist-tag is frozen at an old `0.1.2-rc.1`; the current
> harness line is published under `next`. If you install by tag, prefer `@next`.

## Usage: cut a tool group out of the request prefix (#7080)

Declare each group once — by exact names, by namespace prefix, or both — then name the ones this deployment
cannot use:

```yaml
plugins:
  "@argszero/cordis-plugin-preset-tool-filter":
    groups:
      browser: { names: [cua_driver_native__browser_prepare, cua_driver_native__get_browser_state] }
      recording: { prefix: cua_driver_native__recording }
      session: { names: [cua_driver_native__page] }
    disableGroups: [browser, recording, session]
    # or, without naming a group:
    # deny: [cua_driver_native__get_window_state]
    # denyPrefixes: [cua_driver_native__recording]
```

Every agent created afterwards logs one line:

```
preset-tool-filter: hid 4/9 tools (1214 of 2625 schema bytes, 46.2%, ~304 tokens) on "reporter" [browser=2, recording=2]
```

That is the same measurement #7080 reports by hand, taken from the live agent's own schema surface. Set
`dryRun: true` to rehearse the config and print `would hide …` without changing anything, and `report: false`
to silence it.

**Group membership is an assertion about your provider's catalog, not a runtime invariant.** A name that the
agent cannot see is skipped (never thrown), and a group that matches nothing warns instead of failing the
agent's creation — so a driver upgrade that renames a tool degrades to a warning plus a smaller saving, not to
an unstartable deployment.

### What the restriction does and does not change

| | effect |
|---|---|
| model-facing tool schemas (the per-request prefix) | the group is gone |
| the PTC SDK surface | the group is gone (same view drives both projections) |
| dispatch | `UNKNOWN_TOOL` — the mask is real, not presentational |
| other agents | unaffected (a restriction is per scope) |
| the provider itself | still mounted; its catalog fetch and every capability you kept still work |

The provider still *registers* its catalog at startup (that is a one-time cost, not a per-request one); what the
plugin removes is the per-request prefix and the model's ability to call the group.

## Usage: per-preset allowlist (#5786)

```yaml
plugins:
  "@argszero/cordis-plugin-preset-tool-filter":
    allowlists:
      minimal: [bash, str_replace_editor]
```

For any agent whose composed preset is a key in `allowlists` (default
`{ minimal: ['bash', 'pwsh', 'str_replace_editor'] }`), the plugin calls `tools.restrict({ allow })` on that
agent's scope, masking every other inherited tool. On POSIX the `pwsh` row is disabled by the `minimal` preset,
so each candidate is probed on the agent's scope first and dropped when absent — `restrict` never throws on a
name the platform never mounted.

`allow` and `deny` may both apply; restrictions **intersect**.

### Configuration

| option | type | default | description |
|--------|------|---------|-------------|
| `allowlists` | `Record<string, string[]>` | `{ minimal: ['bash', 'pwsh', 'str_replace_editor'] }` | Per-preset allowlist. Any agent whose composed preset is a key here gets `tools.restrict({ allow })`. |
| `skipUncomposed` | `boolean` | `true` | Skip agents with no composed preset, so the **allowlist** half never affects a bare agent. The deny/group half is never gated by this. |
| `groups` | `Record<string, { names?: string[]; prefix?: string }>` | `{}` | Named tool groups, matched by the union of exact `names` and the `prefix` namespace. |
| `disableGroups` | `string[]` | `[]` | Groups removed from every agent's model-facing surface. |
| `deny` | `string[]` | `[]` | Extra exact tool names removed from every agent. Names the agent cannot see are skipped. |
| `denyPrefixes` | `string[]` | `[]` | Extra namespace prefixes removed from every agent. |
| `report` | `boolean` | `true` | One stderr line per agent describing what was hidden and what it saves. |
| `dryRun` | `boolean` | `false` | Measure and report, apply nothing. |

## How it works

- `restrict` is `ToolRuntime.restrict(filter)` and **requires a scoped context**. It is invoked on `agent.ctx`
  (the agent's own scope), never the plugin root. An unscoped context produces one diagnostic line and no
  throw.
- A restriction masks what the scope **inherits** — the global layer and every ancestor scope layer — and never
  the scope's own registrations (delegation reporting tools, structured-output tools).
- Every configured candidate is resolved against `tools.schemas(agent)` **first**: `restrict` throws for a name
  outside the inheritable set, and an anonymous throw during agent creation is exactly the failure mode this
  plugin exists to avoid.
- The reserved PTC presentation transport (`run_code`) may not be named in a restriction at all; a config that
  names it is dropped silently.
- An agent handle **is** its scope key (`scopeTarget(agent, agent)` in `packages/core/agent/src/index.ts`),
  which is why the plugin passes the `Agent` itself to `tools.schemas()`/`get()`.

### Verified seam

Measured against the published `@deepseek-ai/dsh-tools`, with a global-layer provider, an ancestor scope layer
and the agent's own layer mounted together:

| probe | result |
|-------|--------|
| `restrict({ deny: [<global-layer name>] })` from the agent scope | accepted; the name leaves `schemas()` and `get()`, and dispatches as `UNKNOWN_TOOL` |
| `restrict({ deny: [<ancestor-scope name>] })` | accepted, same effect |
| `restrict({ deny: [<agent-own-layer name>] })` | throws — own registrations are outside the filter |
| `restrict({ deny: [<unknown name>] })` | throws, listing the known names |

The same suite runs green on `0.1.2-rc.1`, `0.1.3-alpha.2`, `0.1.5-rc.2` and `0.1.6-alpha.2` (30/30 each, with
the requested `dsh-tools` version installed for each run) — the seam is identical on all four lines.

## Development

```sh
npm install
npm test        # pretest builds lib/, then node --test runs the suite
```

`test/packaging.spec.mjs` guards two defect classes this series has shipped before: an undeclared runtime
import in the built artifact, and a peer range that silently excludes a line the code actually supports.

## License

MIT
