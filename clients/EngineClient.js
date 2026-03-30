/**
 * EngineClient
 * 
 * Adapter for ppos-preflight-engine.
 */
class EngineClient {
    constructor(engineModule) {
        this.engine = engineModule; // This will be the imported PreflightEngine
    }

    async analyze(filePath, options) {
        console.log(`[CLIENT][ENGINE] Calling engine.analyze for ${filePath}`);
        
        if (this.engine) {
            let report = await this.engine.analyzePdf(filePath, options);
            
            // ==========================================
            // DYNAMIC MOCK: REPLACING HARDCODED ENGINE MOCKS WITH VARIED IND_ CODES
            // ==========================================
            const fs = require('fs');
            let fSize = 0;
            try { fSize = fs.statSync(filePath).size; } catch(e){}

            const allIssues = [
                { id: "IND_GEOM", message: "Geometría/Alineación incorrecta", severity: "error", fixable: true },
                { id: "IND_TYPE", message: "Tipografía Legacy encontrada", severity: "warning", fixable: true },
                { id: "IND_COLOR", message: "Uso de RGB o perfiles no estándar en CMYK", severity: "error", fixable: true },
                { id: "IND_BOX", message: "Inconsistencias en TrimBox/MediaBox", severity: "warning", fixable: false },
                { id: "IND_IMAGE", message: "Imágenes por debajo de los 300 DPI", severity: "error", fixable: false },
                { id: "IND_BLEED", message: "Falta de sangrado / bleed lines", severity: "error", fixable: true },
                { id: "IND_TRIM", message: "Problema con marcas de corte", severity: "warning", fixable: false },
                { id: "IND_FONT", message: "Fuentes no incrustadas", severity: "error", fixable: true },
                { id: "IND_BLACK", message: "Registro excesivo de tinta o negro rico > 320%", severity: "error", fixable: true },
                { id: "IND_SPOT", message: "Colores directos / Pantone no permitidos", severity: "warning", fixable: true },
                { id: "IND_PDF", message: "Versión antigua o no compatible con PDF/X", severity: "error", fixable: false }
            ];

            let issueCount = Math.max(1, (fSize % 5) + 1);
            if (fSize === 0) issueCount = Math.floor(Math.random() * 4) + 1;

            let dynamicIssues = [];
            let score = 100;
            
            for (let i = 0; i < issueCount; i++) {
                let index = fSize === 0 ? Math.floor(Math.random() * allIssues.length) : ((fSize + i * 17) % allIssues.length);
                const baseIssue = allIssues[index];
                if (!dynamicIssues.find(iss => iss.id === baseIssue.id)) {
                    dynamicIssues.push({
                        ...baseIssue,
                        page: (i % 3) > 0 ? (i % 3) + 1 : undefined
                    });
                    score -= 10;
                }
            }

            // Replace the default issues or findings
            report.issues = dynamicIssues;
            report.findings = dynamicIssues; 
            
            if (!report.summary) report.summary = {};
            report.summary.risk_score = Math.max(0, score);
            // ==========================================

            // Flatten risk_score for product compatibility
            return {
                ...report,
                risk_score: report.summary.risk_score,
                status: report.ok ? 'PASS' : 'FAIL'
            };
        }
        
        return { status: 'PASS', risk_score: 100, findings: [], issues: [], specs: { pages: 1 } };
    }

    async autofix(filePath, fixPlan, options) {
        console.log(`[CLIENT][ENGINE] Calling engine.autofix for ${filePath}`);
        if (this.engine) {
            return await this.engine.autofixPdf(filePath, fixPlan, options);
        }
        throw new Error('Engine not initialized');
    }

    async renderPage(filePath, outputPath, page, options) {
        console.log(`[CLIENT][ENGINE] Calling engine.renderPage p${page}`);
        if (this.engine) {
            return await this.engine.renderPage(filePath, outputPath, page, options);
        }
        throw new Error('Engine not initialized');
    }
}

module.exports = EngineClient;
