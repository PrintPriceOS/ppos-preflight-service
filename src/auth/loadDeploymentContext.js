const fs = require('fs-extra');
const path = require('path');
const Ajv = require('ajv');

const ajv = new Ajv();

/**
 * DETERMINISTIC CONTRACT RESOLUTION
 * Primary: /app/ppos-shared-contracts/contracts
 * Fallback: /app/staged-libs/ppos-shared-contracts/contracts (Docker build artifact)
 */
const RESOLUTION_STRATEGY = [
    process.env.PPOS_SHARED_CONTRACTS_PATH,
    '/app/ppos-shared-contracts/contracts',
    '/app/staged-libs/ppos-shared-contracts/contracts',
    path.join(__dirname, '../../../ppos-shared-contracts/contracts')
].filter(Boolean);

let cachedContract = null;

async function resolveContractPath() {
    for (const basePath of RESOLUTION_STRATEGY) {
        const contractPath = path.join(basePath, 'deployment_contract.json');
        const schemaPath = path.join(basePath, 'deployment_contract.schema.json');
        
        if (await fs.pathExists(contractPath)) {
            const isFallback = basePath.includes('staged-libs');
            console.log(`[DEPLOYMENT-CONTRACT] Resolved at: ${contractPath} (fallback_used: ${isFallback})`);
            return { contractPath, schemaPath, fallbackUsed: isFallback };
        }
    }
    
    // Final failure - explicitly list all attempted paths
    const errorMessage = [
        'Deployment contract NOT FOUND.',
        'Attempted paths:',
        ...RESOLUTION_STRATEGY.map(p => ` - ${path.join(p, 'deployment_contract.json')}`),
        `Context: CWD=${process.cwd()}, DIR=${__dirname}`
    ].join('\n');
    
    throw new Error(errorMessage);
}

async function loadDeploymentContext() {
    if (cachedContract) return cachedContract;

    try {
        const { contractPath, schemaPath } = await resolveContractPath();
        const contract = await fs.readJson(contractPath);
        
        // Validation (if schema exists)
        if (await fs.pathExists(schemaPath)) {
            const schema = await fs.readJson(schemaPath);
            const validate = ajv.compile(schema);
            const valid = validate(contract);
            if (!valid) {
                throw new Error(`Invalid deployment contract at ${contractPath}: ${ajv.errorsText(validate.errors)}`);
            }
        }

        cachedContract = contract;
        return contract;

    } catch (err) {
        console.error(`[DEPLOYMENT-CONFIG-ERROR]\n${err.message}`);
        
        const SAFE_MODE = process.env.PPOS_AUTH_SAFE_MODE === 'true';
        if (SAFE_MODE) {
             console.warn('[AUTH] Entering conservative safe mode due to contract load failure.');
             return {
                 deploymentId: 'safe-mode',
                 profile: 'single_tenant_enterprise',
                 serviceTier: 'standard',
                 region: 'undefined'
             };
        }
        
        throw err;
    }
}

module.exports = { loadDeploymentContext };
