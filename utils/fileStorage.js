/**
 * fileStorage Utility
 */
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class FileStorage {
    constructor(basePath) {
        this.basePath = basePath;
    }

    async save(stream, originalName) {
        const id = uuidv4();
        const ext = path.extname(originalName) || '.pdf';
        const storageName = `${id}${ext}`;
        const filePath = path.join(this.basePath, storageName);

        // This is a simplified save logic for Fastify Multipart
        await fs.outputFile(filePath, stream);

        return { id, filePath };
    }

    async getStats(filePath) {
        return await fs.stat(filePath);
    }
}

module.exports = FileStorage;
