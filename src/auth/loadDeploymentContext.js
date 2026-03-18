const fs = require('fs-extra');
const path = require('path');
const Ajv = require('ajv');

const ajv = new Ajv();

// Default path for the deployment contract
const SHARED_CONTRACTS_PATH = process.env.PPOS_SHARED_CONTRACTS_PATH || path.join(__dirname, '../../../ppos-shared-contracts/contracts');
const CONTRACT_FILE = path.join(SHARED_CONTRACTS_PATH, 'deployment_contract.json');
const SCHEMA_FILE = path.join(SHARED_CONTRACTS_PATH, 'deployment_contract.schema.json');

let cachedContract = null;

async function loadDeploymentContext() {
    if (cachedContract) return cachedContract;

    try {
        if (!await fs.pathExists(CONTRACT_FILE)) {
             throw new Error(`Deployment contract not found at ${CONTRACT_FILE}`);
        }

        const contract = await fs.readJson(CONTRACT_FILE);
        
        // Validation (if schema exists)
        if (await fs.pathExists(SCHEMA_FILE)) {
            const schema = await fs.readJson(SCHEMA_FILE);
            const validate = ajv.compile(schema);
            const valid = validate(contract);
            if (!valid) {
                 throw new Error(`Invalid deployment contract: ${ajv.errorsText(validate.errors)}`);
            }
        }

        cachedContract = contract;
        return contract;

    } catch (err) {
        console.error(`[DEPLOYMENT-CONFIG-ERROR] ${err.message}`);
        
        // Conservative safe mode or fail
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
        
        throw err; // Fail safely by crashing/refusing to start if contract is mandatory
    }
}

module.exports = { loadDeploymentContext };
