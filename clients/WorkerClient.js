/**
 * WorkerClient
 * 
 * Adapter for ppos-preflight-worker (BullMQ).
 */
class WorkerClient {
    constructor(queue) {
        this.queue = queue; // Mocked or real BullMQ/Redis queue
    }

    async enqueue(type, data) {
        console.log(`[CLIENT][WORKER] Enqueueing ${type} job`);
        const jobId = `job_${Date.now()}`;
        
        // Mocking enqueuing
        return {
            jobId,
            status: 'QUEUED',
            type
        };
    }
}

module.exports = WorkerClient;
