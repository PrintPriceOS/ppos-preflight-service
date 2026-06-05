class FixCapabilityContract {
    static getCapabilities() {
        return {
            version: "46.0",
            source: "SERVICE_MIRROR",
            engine_registry_compatibility: "phase-44",
            capabilities: [
                {
                    fix_id: "REBUILD_TRIMBOX",
                    label: "Rebuild TrimBox",
                    category: "geometry",
                    implemented: true,
                    detectable: true,
                    autofixable: true,
                    risk_level: "LOW",
                    requires_human_review: false,
                    production_safe: true,
                    destructive: false,
                    toolchain: ["pdf-lib"],
                    supported_modes: ["SAFE", "REVIEW_REQUIRED", "EXPERIMENTAL"],
                    customer_message: "Automatically rebuilds corrupted page geometry.",
                    operator_message: "Restores TrimBox/MediaBox boundaries."
                },
                {
                    fix_id: "APPLY_BLEED",
                    label: "Apply Bleed Margin",
                    category: "geometry",
                    implemented: true,
                    detectable: true,
                    autofixable: true,
                    risk_level: "LOW",
                    requires_human_review: false,
                    production_safe: true,
                    destructive: false,
                    toolchain: ["pdf-lib"],
                    supported_modes: ["SAFE", "REVIEW_REQUIRED", "EXPERIMENTAL"],
                    customer_message: "Adds bleed margins by mirroring edges.",
                    operator_message: "Generates bleed via edge mirroring."
                },
                {
                    fix_id: "CONVERT_CMYK",
                    label: "Convert to CMYK",
                    category: "color",
                    implemented: true,
                    detectable: true,
                    autofixable: true,
                    risk_level: "MEDIUM",
                    requires_human_review: true,
                    production_safe: false,
                    destructive: true,
                    toolchain: ["ghostscript", "pdf-lib"],
                    supported_modes: ["REVIEW_REQUIRED", "EXPERIMENTAL"],
                    customer_message: "Converts colors to print-safe CMYK.",
                    operator_message: "Ghostscript CMYK conversion (requires review)."
                },
                {
                    fix_id: "STRIP_JAVASCRIPT",
                    label: "Strip JavaScript",
                    category: "security",
                    implemented: true,
                    detectable: true,
                    autofixable: true,
                    risk_level: "LOW",
                    requires_human_review: false,
                    production_safe: true,
                    destructive: false,
                    toolchain: ["pdf-lib"],
                    supported_modes: ["SAFE", "REVIEW_REQUIRED", "EXPERIMENTAL"],
                    customer_message: "Removes malicious or interactive scripts.",
                    operator_message: "Strips PDF JS actions."
                },
                {
                    fix_id: "EMBED_FONTS",
                    label: "Embed Fonts",
                    category: "fonts",
                    implemented: false,
                    detectable: true,
                    autofixable: false,
                    risk_level: "HIGH",
                    requires_human_review: true,
                    production_safe: false,
                    destructive: true,
                    toolchain: ["ghostscript"],
                    supported_modes: ["EXPERIMENTAL"],
                    customer_message: "Embeds missing fonts (Unsupported).",
                    operator_message: "Font embedding via Ghostscript (Unsupported)."
                }
            ],
            policy_modes: [
                "SAFE",
                "REVIEW_REQUIRED",
                "EXPERIMENTAL"
            ]
        };
    }
}

module.exports = FixCapabilityContract;
