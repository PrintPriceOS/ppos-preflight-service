const { Queue } = require('bullmq');

class WorkerClient {
    constructor(redisConfig) {
        this.queueName = process.env.PPOS_QUEUE_NAME || 'preflight_async_queue';
        this.queue = new Queue(this.queueName, {
            connection: redisConfig
        });
    }

    async enqueue(type, data) {
        console.log(`[CLIENT][WORKER] Enqueueing ${type} job to ${this.queueName}`);
        
        try {
            const job = await this.queue.add(type, data, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000
                }
            });

            return {
                job_id: job.id,
                status: 'QUEUED',
                type
            };
        } catch (err) {
            console.error(`[CLIENT][WORKER] Failed to enqueue job: ${err.message}`);
            throw err;
        }
    }
}

module.exports = WorkerClient;
