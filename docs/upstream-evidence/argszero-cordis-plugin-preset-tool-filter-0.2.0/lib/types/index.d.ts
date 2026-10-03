/**
 * @argszero/cordis-plugin-preset-tool-filter — Cordis plugin entry.
 *
 * Two public `tools.restrict()` use cases for one seam, applied by
 * `agent/created` on the agent's OWN scope context:
 *
 *  1. #5786 — per-preset ALLOWLIST. A preset (notably `minimal`) captures only a
 *     small fixed tool set, yet every agent also INHERITS the tool registry's
 *     global layer and every ancestor layer on its scope chain. Because preset
 *     composition mounts its rows into a standing ancestor scope and never
 *     applies a `ToolRestriction`, plugin commands registered at the global
 *     layer leak through: the model sees a catalog far larger than intended.
 *
 *  2. #7080 — per-deployment tool-GROUP opt-out. A provider that registers a
 *     large catalog unconditionally (the computer-use driver: 55 tools, ~94 KB
 *     / ~23.5k tokens of request prefix in the reporter's environment) has no
 *     registration-time knob, and disabling the whole provider also removes the
 *     capabilities the deployment does use. Denying the group on the agent
 *     scope removes exactly those tools from the model-facing schema surface
 *     (and from dispatch) while the provider stays mounted.
 *
 * Both are the SAME mechanism: a restriction masks what the scope INHERITS —
 * the global layer and every ancestor scope layer — and never the scope's own
 * registrations. A config-mounted provider plugin contributes to the global
 * layer, so its tools are restrictable from any agent scope. Verified at
 * runtime against the published `@deepseek-ai/dsh-tools` (0.1.2-rc.1,
 * 0.1.3-alpha.2, 0.1.5-rc.2, 0.1.6-alpha.2): a global-layer name survives
 * `restrict()` unthrown, leaves `schemas()`/`get()`, and dispatches as
 * `UNKNOWN_TOOL`; an ancestor-scope name behaves the same; a name registered in
 * the agent's OWN layer throws, as does an unknown name.
 *
 * Mechanism notes (verified against packages/core/tools/src/index.ts):
 *  - `restrict` is `ToolRuntime.restrict(filter)` and REQUIRES the calling
 *    context to carry a scope tag, so it must be invoked on `agent.ctx`, not on
 *    the plugin's (root) context.
 *  - `restrictableNames` (the name-validation set) is built from the INHERITED
 *    surface — global layer plus every non-own layer on the chain — so a name
 *    absent from it throws. This plugin therefore resolves every configured
 *    candidate against the agent's visible surface FIRST and never names a tool
 *    the agent cannot see.
 *  - `allow` and `deny` may be passed in separate calls; restrictions intersect.
 *  - The reserved PTC presentation transport (`run_code`) may not be named at
 *    all; a config that names it is dropped with a warning instead of throwing.
 *  - A restriction is per-scope: sibling agents keep their full surface.
 *
 * @module @argszero/cordis-plugin-preset-tool-filter
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "preset-tool-filter";
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** Emitted by the agent registry when an agent is published. */
        'agent/created'(payload: {
            agent: Agent;
        }): void;
    }
}
interface Agent {
    readonly ctx: Context;
    /** Session id; used only to label the report line. */
    readonly id?: string;
}
/**
 * One named group of model-facing tools. Membership is the union of the exact
 * `names` and every visible tool name starting with `prefix`.
 */
export interface ToolGroup {
    /** Exact model-facing tool names in this group. */
    readonly names?: readonly string[];
    /** Namespace prefix shared by this group's tools (e.g. `cua_driver_native__browser`). */
    readonly prefix?: string;
}
/** Plugin config. */
export interface PresetToolFilterConfig {
    /**
     * Map of preset name → allowed tool names (#5786). For any agent whose
     * composed preset is a key here, `tools.restrict({ allow })` masks every
     * other global/ancestor tool. Defaults to `{ minimal: ['bash', 'pwsh',
     * 'str_replace_editor'] }`.
     */
    allowlists?: Record<string, readonly string[]>;
    /**
     * When true (default), skip an agent that carries no composed preset (a
     * bare/global agent) so the ALLOWLIST half never affects a preset-less agent.
     * The deny/group half is never gated by this: a deployment-wide opt-out must
     * apply to every agent. Set false only if you know you want the default
     * allowlist enforced everywhere.
     */
    skipUncomposed?: boolean;
    /**
     * Named tool groups (#7080), e.g.
     * `{ browser: { prefix: 'cua_driver_native__browser' },
     *    recording: { names: ['cua_driver_native__recording_start'] } }`.
     */
    groups?: Record<string, ToolGroup>;
    /** Names of `groups` entries to remove from every agent's model-facing surface. */
    disableGroups?: readonly string[];
    /** Extra exact tool names removed from every agent. Absent names are skipped. */
    deny?: readonly string[];
    /** Extra name prefixes removed from every agent. */
    denyPrefixes?: readonly string[];
    /**
     * When true (default), write one line per agent to stderr reporting how many
     * tools were hidden and how many schema bytes/tokens that saves — the same
     * measurement #7080 reports by hand.
     */
    report?: boolean;
    /** Measure and report, but do not apply the restriction (config rehearsal). */
    dryRun?: boolean;
}
export declare function apply(ctx: Context, config?: PresetToolFilterConfig): void;
export {};
