const IdentityValidator = require('./src/utils/identityValidator');
const { ErrorCodes } = require('./src/utils/errors');

function runTests() {
    console.log('--- Starting Identity Validation Smoke Check ---');
    
    const testCases = [
        { id: 'job_12345', expected: true },
        { id: 'fix_67890', expected: true },
        { id: 'sync_fix_abcde', expected: true },
        { id: '32', expected: false, note: 'Plain numeric ID (potential leak)' },
        { id: 'random_id', expected: false, note: 'Missing canonical prefix' },
        { id: null, expected: false },
        { id: undefined, expected: false },
        { id: {}, expected: false }
    ];

    let passed = 0;
    testCases.forEach((tc, i) => {
        const result = IdentityValidator.isValidJobId(tc.id);
        const status = result === tc.expected ? 'PASS' : 'FAIL';
        if (status === 'PASS') passed++;
        console.log(`[Test ${i+1}] ID: ${tc.id} | Expected: ${tc.expected} | Result: ${result} | Status: ${status} ${tc.note ? `(${tc.note})` : ''}`);
        
        if (tc.expected === false) {
             try {
                 IdentityValidator.validate(tc.id, 'TestResource');
                 console.log(`  [FAIL] Expected validation to throw for ${tc.id}`);
             } catch (err) {
                 if (err.code === ErrorCodes.INVALID_IDENTITY) {
                     console.log(`  [PASS] Correctly threw INVALID_IDENTITY for ${tc.id}`);
                 } else {
                     console.log(`  [FAIL] Threw wrong error code: ${err.code}`);
                 }
             }
        }
    });

    console.log(`\n--- Results: ${passed}/${testCases.length} Passed ---`);
    if (passed === testCases.length) {
        console.log('ALL TESTS PASSED');
        process.exit(0);
    } else {
        console.log('SOME TESTS FAILED');
        process.exit(1);
    }
}

runTests();
