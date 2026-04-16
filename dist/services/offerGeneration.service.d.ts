/**
 * Offer Generation Service
 *
 * Triggers the queue-based hotel probe pipeline, waits for all jobs to finish,
 * then applies Step 3.5 accumulation gate (accept/skip hotels until target met),
 * builds a proposal from the accepted hotels, and notifies staff.
 */
export declare class OfferGenerationService {
    /**
     * Trigger the full offer generation pipeline asynchronously (fire-and-forget).
     */
    triggerAsync(requestId: string): void;
    run(requestId: string): Promise<void>;
}
declare const _default: OfferGenerationService;
export default _default;
