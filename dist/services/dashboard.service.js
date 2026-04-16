"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardService = void 0;
const client_1 = require("@prisma/client");
const request_repository_1 = __importDefault(require("../repositories/request.repository"));
const roomUtils_1 = require("../utils/roomUtils");
const prisma = new client_1.PrismaClient();
/** Start of last calendar month (UTC). */
function startOfLastMonth() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}
/** Start of current calendar month (UTC). */
function startOfThisMonth() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
/** Safe percent-change: ((current - previous) / previous) * 100. */
function pctChange(current, previous) {
    if (previous === 0)
        return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 1000) / 10; // 1 decimal place
}
class DashboardService {
    /**
     * Returns the 4 stat cards shown on the Dashboard:
     *   - Total Requests
     *   - Pending Requests
     *   - Sent Offers
     *   - Declined
     * Each includes a vs-last-month percentage change.
     */
    async getStats() {
        const thisMonthStart = startOfThisMonth();
        const lastMonthStart = startOfLastMonth();
        const [totalAll, totalLastMonth, pendingAll, pendingLastMonth, sentOffersAll, sentOffersLastMonth, declinedAll, declinedLastMonth,] = await Promise.all([
            // Total requests (all time)
            request_repository_1.default.countAll(),
            // Total requests created last month
            request_repository_1.default.countAllSince(lastMonthStart),
            // Pending requests (all time)
            request_repository_1.default.countByStatus(client_1.BookingRequestStatus.pending),
            // Pending requests since last month start
            request_repository_1.default.countByStatusSince(client_1.BookingRequestStatus.pending, lastMonthStart),
            // Sent offers (proposals with status = sent, all time)
            prisma.proposal.count({ where: { status: client_1.ProposalStatus.sent } }),
            // Sent offers created last month
            prisma.proposal.count({
                where: { status: client_1.ProposalStatus.sent, sentAt: { gte: lastMonthStart } },
            }),
            // Declined offers (all time)
            prisma.proposal.count({ where: { status: client_1.ProposalStatus.declined } }),
            // Declined offers last month
            prisma.proposal.count({
                where: {
                    status: client_1.ProposalStatus.declined,
                    updatedAt: { gte: lastMonthStart },
                },
            }),
        ]);
        // "vs last month" uses records created in the current month vs last month
        const totalThisMonth = await request_repository_1.default.countAllSince(thisMonthStart);
        const pendingThisMonth = await request_repository_1.default.countByStatusSince(client_1.BookingRequestStatus.pending, thisMonthStart);
        const sentThisMonth = await prisma.proposal.count({
            where: { status: client_1.ProposalStatus.sent, sentAt: { gte: thisMonthStart } },
        });
        const declinedThisMonth = await prisma.proposal.count({
            where: { status: client_1.ProposalStatus.declined, updatedAt: { gte: thisMonthStart } },
        });
        // lastMonth counts = (since lastMonthStart) - (since thisMonthStart)
        const totalLM = totalLastMonth - totalThisMonth;
        const pendingLM = pendingLastMonth - pendingThisMonth;
        const sentLM = sentOffersLastMonth - sentThisMonth;
        const declinedLM = declinedLastMonth - declinedThisMonth;
        return {
            totalRequests: {
                value: totalAll,
                vsLastMonth: pctChange(totalThisMonth, totalLM),
            },
            pendingRequests: {
                value: pendingAll,
                vsLastMonth: pctChange(pendingThisMonth, pendingLM),
            },
            sentOffers: {
                value: sentOffersAll,
                vsLastMonth: pctChange(sentThisMonth, sentLM),
            },
            declined: {
                value: declinedAll,
                vsLastMonth: pctChange(declinedThisMonth, declinedLM),
            },
        };
    }
    /**
     * Returns the recent offers list shown on the Dashboard table.
     * Each row: offerNumber, customer, destination, checkIn/Out, rooms, totalSell, margin, status.
     */
    async getRecentOffers(limit = 10) {
        const rows = await request_repository_1.default.getRecentOffers(limit);
        return rows.map((r) => {
            const proposal = r.proposals[0] ?? null;
            const totalSell = proposal?.totalSell ? Number(proposal.totalSell) : null;
            const totalBuy = proposal?.totalBuy ? Number(proposal.totalBuy) : null;
            const margin = totalSell !== null && totalBuy !== null ? totalSell - totalBuy : null;
            const marginPct = margin !== null && totalSell
                ? Math.round((margin / totalSell) * 1000) / 10
                : null;
            // Total room count from rooms JSON
            const totalRooms = (0, roomUtils_1.countTotalRooms)(r.rooms);
            return {
                id: r.id,
                referenceNumber: r.referenceNumber,
                offerId: `#${r.referenceNumber}`,
                customer: r.companyName ?? [r.firstName, r.lastName].filter(Boolean).join(' '),
                destination: r.destinationName,
                checkinDate: r.checkinDate,
                checkoutDate: r.checkoutDate ?? null,
                nights: r.nights,
                totalRooms: totalRooms || null,
                groupSize: r.groupSize ?? null,
                totalSell,
                totalBuy,
                margin,
                marginPct,
                status: r.status,
                proposalId: proposal?.id ?? null,
                createdAt: r.createdAt,
            };
        });
    }
}
exports.DashboardService = DashboardService;
exports.default = new DashboardService();
