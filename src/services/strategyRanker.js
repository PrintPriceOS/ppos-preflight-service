/**
 * Strategy Ranking Engine
 * Phase 12 — Learning & Outcome Optimization Loop
 */

const { queryOutcomes } = require('./optimizationMemory');

/**
 * Ranks strategies based on contextual success.
 */
function rankStrategies(context = {}) {
    const outcomes = queryOutcomes({
        serviceTier: context.serviceTier,
        isolationMode: context.isolationMode
    });

    const strategyStats = {};

    for (const o of outcomes) {
        if (!strategyStats[o.type]) {
            strategyStats[o.type] = { type: o.type, total: 0, wins: 0, losses: 0, unsafes: 0, improvements: [] };
        }
        
        strategyStats[o.type].total += 1;
        if (o.verdict === 'IMPROVED') {
            strategyStats[o.type].wins += 1;
            
            // Extract baseline metric improvements
            if (o.metricsBefore && o.metricsAfter && o.expectedBenefit?.metric) {
                const metric = o.expectedBenefit.metric;
                const diff = (o.metricsBefore[metric] || 0) - (o.metricsAfter[metric] || 0);
                if (!isNaN(diff)) strategyStats[o.type].improvements.push(Math.abs(diff));
            }
        } else if (o.verdict === 'REGRESSED') {
            strategyStats[o.type].losses += 1;
        } else if (o.verdict === 'UNSAFE') {
            strategyStats[o.type].unsafes += 1;
        }
    }

    const bestStrategies = [];

    for (const [type, stats] of Object.entries(strategyStats)) {
        const decided = stats.wins + stats.losses + stats.unsafes;
        if (decided === 0) continue;
        
        let successRate = (stats.wins / decided) * 100;
        
        // Massive penalty to success rate if unsafe/regressed
        successRate -= (stats.unsafes * 15);
        successRate -= (stats.losses * 5);
        
        if (successRate < 0) successRate = 0;

        const avgImprov = stats.improvements.length > 0 
            ? stats.improvements.reduce((a,b)=>a+b, 0) / stats.improvements.length 
            : 0;

        bestStrategies.push({
            type,
            successRate: Number(successRate.toFixed(1)),
            averageImprovement: Number(avgImprov.toFixed(2)),
            sampleSize: stats.total
        });
    }

    // Sort highest success rate first
    bestStrategies.sort((a,b) => b.successRate - a.successRate);

    // Attach mock confidence scores from external adjuster layer for UI merging
    return {
        context,
        bestStrategies
    };
}

module.exports = {
    rankStrategies
};
