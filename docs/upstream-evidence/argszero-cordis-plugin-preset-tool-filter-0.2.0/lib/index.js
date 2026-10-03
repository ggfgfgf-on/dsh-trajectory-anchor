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
export const name = 'preset-tool-filter';
/** Reserved PTC presentation transport; naming it in a restriction throws. */
const RUN_CODE_NAME = 'run_code';
const DEFAULT_ALLOWLISTS = {
    minimal: ['bash', 'pwsh', 'str_replace_editor'],
};
function warn(message) {
    // Dependency-free on purpose: the plugin must build and run under plain Node
    // without a host logger. A stderr write is enough for a config-error surface.
    process.stderr.write(`preset-tool-filter: ${message}\n`);
}
/** A thrown value is not guaranteed to be an `Error`; never report `undefined`. */
function reason(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Resolve the configured deny intent against what this agent can actually see.
 * Naming an invisible tool throws inside `restrict()`, so every candidate is
 * filtered here first — a group is a CONFIG assertion, not a runtime invariant.
 */
function plan(visible, config) {
    const hidden = new Set();
    const groups = [];
    const seen = new Set(visible);
    for (const key of config.disableGroups ?? []) {
        const group = config.groups?.[key];
        if (group === undefined) {
            warn(`disableGroups names group "${key}" but config.groups has no such entry`);
            continue;
        }
        const matched = new Set();
        for (const candidate of group.names ?? []) {
            if (seen.has(candidate))
                matched.add(candidate);
        }
        if (group.prefix !== undefined) {
            for (const candidate of visible) {
                if (candidate.startsWith(group.prefix))
                    matched.add(candidate);
            }
        }
        if (matched.size === 0)
            warn(`group "${key}" matched no visible tool`);
        groups.push([key, [...matched]]);
        for (const matchedName of matched)
            hidden.add(matchedName);
    }
    for (const candidate of config.deny ?? []) {
        if (seen.has(candidate))
            hidden.add(candidate);
    }
    for (const prefix of config.denyPrefixes ?? []) {
        for (const candidate of visible) {
            if (candidate.startsWith(prefix))
                hidden.add(candidate);
        }
    }
    hidden.delete(RUN_CODE_NAME);
    return { deny: [...hidden], groups };
}
/** Sum the serialized size of the named schemas: the model-facing prefix cost. */
function schemaBytes(schemas, names) {
    let total = 0;
    for (const schema of schemas) {
        if (names.has(schema.name))
            total += JSON.stringify(schema).length;
    }
    return total;
}
function reportPlan(agent, config, plan, schemas, dryRun) {
    const label = agent.id ?? 'agent';
    const total = schemaBytes(schemas, new Set(schemas.map(schema => schema.name)));
    const saved = schemaBytes(schemas, new Set(plan.deny));
    const share = total === 0 ? 0 : (saved / total) * 100;
    const detail = plan.groups.map(([key, matched]) => `${key}=${matched.length}`).join(', ');
    const verb = dryRun ? 'would hide' : 'hid';
    warn(`${verb} ${plan.deny.length}/${schemas.length} tools (${saved} of ${total} schema bytes, ${share.toFixed(1)}%, ~${Math.round(saved / 4)} tokens) on "${label}"${detail.length > 0 ? ` [${detail}]` : ''}`);
}
export function apply(ctx, config = {}) {
    const allowlists = config.allowlists ?? DEFAULT_ALLOWLISTS;
    const skipUncomposed = config.skipUncomposed ?? true;
    const report = config.report ?? true;
    const dryRun = config.dryRun ?? false;
    const presetKeys = new Set(Object.keys(allowlists));
    ctx.on('agent/created', (payload) => {
        const agent = payload?.agent;
        if (agent === undefined)
            return;
        // `ctx.get(name)` resolves the service through the agent's scope chain; the
        // string overload returns `any`, so narrowing to the structural face below.
        const tools = agent.ctx.get('tools');
        if (tools === undefined)
            return;
        // The visible surface is the resolution source for BOTH halves: it is what
        // `schemas()` will render into the request, and every name in it is a legal
        // `restrict()` argument.
        const schemas = typeof tools.schemas === 'function' ? tools.schemas(agent) : [];
        const visible = schemas.map(schema => schema.name);
        // --- deny half (#7080): never gated by preset composition ----------------
        const denied = plan(visible, config);
        if (denied.deny.length > 0 || dryRun) {
            if (report)
                reportPlan(agent, config, denied, schemas, dryRun);
            if (!dryRun && denied.deny.length > 0) {
                try {
                    tools.restrict({ deny: denied.deny });
                }
                catch (error) {
                    warn(reason(error));
                }
            }
        }
        // --- allowlist half (#5786): preset-keyed -------------------------------
        const presets = agent.ctx.get('agentPresets');
        if (presets === undefined)
            return;
        let preset;
        try {
            preset = presets.composedPreset(agent.ctx);
        }
        catch {
            return;
        }
        if (preset === undefined) {
            if (skipUncomposed)
                return;
        }
        else if (!presetKeys.has(preset)) {
            return;
        }
        const allow = (allowlists[preset ?? ''] ?? [])
            // `restrict` throws for a name absent from the inherited surface, and a
            // platform-disabled preset tool (e.g. `pwsh` on POSIX) will be absent.
            .filter(name => tools.get(name, agent) !== undefined);
        if (allow.length === 0)
            return;
        // Applying the restriction on the agent's own scoped context masks what it
        // INHERITS while keeping its own layer registrations (e.g. delegation
        // reporting tools) and the reserved PTC mode transport intact.
        if (dryRun)
            return;
        try {
            tools.restrict({ allow });
        }
        catch (error) {
            warn(reason(error));
        }
    });
}
