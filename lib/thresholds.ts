import type { PluginConfig } from "./config"

// A percentage threshold cannot be turned into a token count until the host
// reports the model context window, so the configured form is what the user needs
// to see. A warning that lists only the offending keys leaves the most damaging
// failure mode - wrong thresholds rather than an error - invisible (#631).
//
// This lives apart from config.ts so it stays importable without pulling in the
// JSONC parser, whose published ESM entry has no named `parse` export and is only
// usable once tsup bundles it.
export function describeEffectiveThresholds(config: PluginConfig): string {
    const describe = (value: unknown): string => {
        if (typeof value === "number") {
            return `${value} tokens`
        }
        if (typeof value === "string") {
            return value.endsWith("%") ? `"${value}" of the model context window` : `"${value}"`
        }
        return String(value)
    }

    return (
        `Effective thresholds: compress.minContextLimit=${describe(config.compress.minContextLimit)}, ` +
        `compress.maxContextLimit=${describe(config.compress.maxContextLimit)}`
    )
}

export const CONFIG_REQUIRES_RESTART_NOTE =
    "Config is read once at startup - restart OpenCode after editing it."
