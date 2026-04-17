/**
 * Preflight Policy Catalog
 * Aligned with modern print workflows and ICC/profile-aware enforcement.
 */

const policyCatalog = [
    {
        id: "OFFSET_MODERN_COATED_F51",
        name: "Offset Modern Coated (FOGRA51)",
        profile: "FOGRA51",
        category: "offset",
        colorSpace: "CMYK",
        substrate: "coated",
        standard: "ISO 12647",
        rules: {
            maxTotalInkCoverage: 300,
            allowRgbImages: false,
            requireOutputIntent: true
        }
    },
    {
        id: "OFFSET_MODERN_UNCOATED_F52",
        name: "Offset Modern Uncoated (FOGRA52)",
        profile: "FOGRA52",
        category: "offset",
        colorSpace: "CMYK",
        substrate: "uncoated",
        standard: "ISO 12647",
        rules: {
            maxTotalInkCoverage: 300,
            allowRgbImages: false,
            requireOutputIntent: true
        }
    },
    {
        id: "OFFSET_LEGACY_COATED_F39",
        name: "Offset Legacy Coated (FOGRA39)",
        profile: "FOGRA39",
        category: "offset",
        colorSpace: "CMYK",
        substrate: "coated",
        standard: "ISO Coated v2",
        rules: {
            maxTotalInkCoverage: 300,
            allowRgbImages: false,
            requireOutputIntent: true
        }
    },
    {
        id: "OFFSET_LEGACY_UNCOATED_F29",
        name: "Offset Legacy Uncoated (FOGRA29)",
        profile: "FOGRA29",
        category: "offset",
        colorSpace: "CMYK",
        substrate: "uncoated",
        standard: "ISO 12647",
        rules: {
            maxTotalInkCoverage: 300,
            allowRgbImages: false,
            requireOutputIntent: true
        }
    },
    {
        id: "US_COATED_GRACOL",
        name: "US Coated (GRACoL)",
        profile: "GRACoL2006",
        category: "offset",
        colorSpace: "CMYK",
        region: "US",
        substrate: "coated",
        standard: "GRACoL",
        rules: {
            maxTotalInkCoverage: 300,
            allowRgbImages: false,
            requireOutputIntent: true
        }
    },
    {
        id: "US_WEB_SWOP",
        name: "US Web (SWOP)",
        profile: "SWOP",
        category: "web_offset",
        colorSpace: "CMYK",
        region: "US",
        standard: "SWOP",
        rules: {
            maxTotalInkCoverage: 300,
            allowRgbImages: false,
            requireOutputIntent: true
        }
    },
    {
        id: "NEWSPAPER_ISO",
        name: "ISO Newspaper",
        profile: "ISOnewspaper26v4",
        category: "newspaper",
        colorSpace: "CMYK",
        standard: "ISO 12647-3",
        rules: {
            maxTotalInkCoverage: 240,
            allowRgbImages: false,
            requireOutputIntent: true
        }
    },
    {
        id: "DIGITAL_RGB",
        name: "Digital RGB",
        profile: "sRGB IEC61966-2.1",
        category: "digital",
        colorSpace: "RGB",
        standard: "sRGB",
        rules: {
            allowRgbImages: true,
            requireOutputIntent: false
        }
    }
];

// Phase 10: Initialization logging
console.log(`[POLICY][CATALOG] Loaded ${policyCatalog.length} production policies: ${policyCatalog.map(p => p.id).join(', ')}`);

module.exports = policyCatalog;
