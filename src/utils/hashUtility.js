const crypto = require('crypto');
const fs = require('fs-extra');

/**
 * HashUtility
 * Provides crypto-graphic hashing for file comparison.
 */
class HashUtility {
    /**
     * Computes SHA-256 hash of a file.
     * @param {string} filePath Path to the file.
     * @returns {Promise<string>} Hex encoded hash.
     */
    static async computeFileHash(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);

            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', (err) => reject(err));
        });
    }

    /**
     * Compares two files by hash.
     * @param {string} pathA
     * @param {string} pathB
     * @returns {Promise<boolean>} True if files are identical.
     */
    static async areFilesIdentical(pathA, pathB) {
        try {
            const hashA = await this.computeFileHash(pathA);
            const hashB = await this.computeFileHash(pathB);
            return hashA === hashB;
        } catch (err) {
            console.error(`[HASH-UTIL][ERROR] Comparison failed: ${err.message}`);
            return false;
        }
    }
}

module.exports = HashUtility;
