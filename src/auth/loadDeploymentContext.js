const fs = require('fs');
const path = require('path');

const RESOLUTION_STRATEGY = [
    path.join(process.cwd(), 'node_modules', '@ppos', 'shared-contracts', 'contracts'),
    path.join(process.cwd(), 'ppos-shared-contracts', 'contracts'),
    path.join(process.cwd(), 'staged-libs', 'ppos-shared-contracts', 'contracts'),
    path.join(path.sep, 'ppos-shared-contracts', 'contracts')
];

function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadDeploymentContext() {
    for (const basePath of RESOLUTION_STRATEGY) {
        const contractPath = path.join(basePath, 'deployment_contract.json');
        const schemaPath = path.join(basePath, 'deployment_contract.schema.json');

        const contractExists = fs.existsSync(contractPath);
        const schemaExists = fs.existsSync(schemaPath);

        if (contractExists && schemaExists) {
            console.log(`[DEPLOYMENT-CONTRACT] Resolved at: ${contractPath}`);
            return {
                contract: loadJson(contractPath),
                schema: loadJson(schemaPath),
                contractPath,
                schemaPath
            };
        }
    }

    const errorMessage = [
        'Deployment contract NOT FOUND.',
        'Attempted paths:',
        ...RESOLUTION_STRATEGY.map(p => ` - ${path.join(p, 'deployment_contract.json')}`),
        `Context: CWD=${process.cwd()}, DIR=${__dirname}`
    ].join('\n');

    console.error(`[DEPLOYMENT-CONFIG-ERROR]\n${errorMessage}`);
    throw new Error(errorMessage);
}

module.exports = { loadDeploymentContext };
