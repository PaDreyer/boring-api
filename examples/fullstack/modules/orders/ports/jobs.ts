import type { ExecutionContext, JobReceipt } from "@boringapi/core";
import type { QueuedOrder } from "../schemas";

export interface OrderJobs {
    enqueue(execution: ExecutionContext, payload: QueuedOrder): Promise<JobReceipt>;
}
