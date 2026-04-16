export declare class DashboardService {
    /**
     * Returns the 4 stat cards shown on the Dashboard:
     *   - Total Requests
     *   - Pending Requests
     *   - Sent Offers
     *   - Declined
     * Each includes a vs-last-month percentage change.
     */
    getStats(): Promise<{
        totalRequests: {
            value: number;
            vsLastMonth: number;
        };
        pendingRequests: {
            value: number;
            vsLastMonth: number;
        };
        sentOffers: {
            value: number;
            vsLastMonth: number;
        };
        declined: {
            value: number;
            vsLastMonth: number;
        };
    }>;
    /**
     * Returns the recent offers list shown on the Dashboard table.
     * Each row: offerNumber, customer, destination, checkIn/Out, rooms, totalSell, margin, status.
     */
    getRecentOffers(limit?: number): Promise<{
        id: string;
        referenceNumber: number;
        offerId: string;
        customer: string;
        destination: string | null;
        checkinDate: Date;
        checkoutDate: any;
        nights: number;
        totalRooms: number | null;
        groupSize: any;
        totalSell: number | null;
        totalBuy: number | null;
        margin: number | null;
        marginPct: number | null;
        status: import(".prisma/client").$Enums.BookingRequestStatus;
        proposalId: any;
        createdAt: Date;
    }[]>;
}
declare const _default: DashboardService;
export default _default;
