import { PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';

const prisma = new PrismaClient();

export interface HotelCodeRow {
    hotelCode: string;
    name: string;
    starRating: Decimal | null;
    destinationId: number | null;
    addressCity: string | null;
    addressCountry: string | null;
}

export class HotelSearchRepository {
    /**
     * Returns hotel codes for a given destination, filtered by star ratings.
     * Used to build the HotelIds list for the WBE search call.
     */
    async getHotelCodesByDestination(
        destinationId: number,
        starRatings: number[],
        limit = 200,
    ): Promise<HotelCodeRow[]> {
        if (starRatings.length === 0) {
            return prisma.hotel.findMany({
                where: { destinationId },
                select: {
                    hotelCode: true,
                    name: true,
                    starRating: true,
                    destinationId: true,
                    addressCity: true,
                    addressCountry: true,
                },
                take: limit,
            });
        }

        // Build OR clause for each star rating (allow 0.5 tolerance)
        return prisma.hotel.findMany({
            where: {
                destinationId,
                OR: starRatings.flatMap((star) => [
                    { starRating: { gte: new Decimal(star - 0.49), lte: new Decimal(star + 0.49) } },
                ]),
            },
            select: {
                hotelCode: true,
                name: true,
                starRating: true,
                destinationId: true,
                addressCity: true,
                addressCountry: true,
            },
            take: limit,
        });
    }

    /**
     * Returns a map of hotelCode → hotel info for enriching search results.
     */
    async getHotelsByCode(hotelCodes: string[]): Promise<Map<string, HotelCodeRow>> {
        if (hotelCodes.length === 0) return new Map();

        const hotels = await prisma.hotel.findMany({
            where: { hotelCode: { in: hotelCodes } },
            select: {
                hotelCode: true,
                name: true,
                starRating: true,
                destinationId: true,
                addressCity: true,
                addressCountry: true,
            },
        });

        const map = new Map<string, HotelCodeRow>();
        for (const h of hotels) map.set(h.hotelCode, h);
        return map;
    }

    /**
     * Returns a cached option detail by TID, or null if not found / expired.
     */
    async getCachedOptionDetail(tid: string) {
        return prisma.hotelOptionDetail.findUnique({
            where: { tid },
        });
    }

    /**
     * Upserts an option detail into the cache.
     */
    async upsertOptionDetail(data: {
        tid: string;
        hotelCode?: string;
        data: any;
        nonRefundable?: boolean;
        cxlOptionDate?: Date | null;
        cxlConditions?: any;
        cxlComment?: string;
        cxlRemarks?: any;
        daypricesTotal?: number;
        daypricesCurrency?: string;
        mealType?: string;
        mealName?: string;
        providerPrice?: number;
        providerCurrency?: string;
        supplierCode?: string;
        essentialInfo?: string;
        priceComment?: string;
        supplements?: any;
        optionalExtras?: any;
        specialOffers?: any;
        rooms?: any;
        success?: boolean;
        versionDescription?: string;
        expiresAt?: Date;
    }) {
        const payload: any = {
            tid: data.tid,
            data: data.data,
            fetchedAt: new Date(),
        };

        if (data.hotelCode !== undefined) payload.hotelCode = data.hotelCode;
        if (data.nonRefundable !== undefined) payload.nonRefundable = data.nonRefundable;
        if (data.cxlOptionDate !== undefined) payload.cxlOptionDate = data.cxlOptionDate;
        if (data.cxlConditions !== undefined) payload.cxlConditions = data.cxlConditions;
        if (data.cxlComment !== undefined) payload.cxlComment = data.cxlComment;
        if (data.cxlRemarks !== undefined) payload.cxlRemarks = data.cxlRemarks;
        if (data.daypricesTotal !== undefined) payload.daypricesTotal = new Decimal(data.daypricesTotal).toFixed(2);
        if (data.daypricesCurrency !== undefined) payload.daypricesCurrency = data.daypricesCurrency;
        if (data.mealType !== undefined) payload.mealType = data.mealType;
        if (data.mealName !== undefined) payload.mealName = data.mealName;
        if (data.providerPrice !== undefined) payload.providerPrice = new Decimal(data.providerPrice).toFixed(2);
        if (data.providerCurrency !== undefined) payload.providerCurrency = data.providerCurrency;
        if (data.supplierCode !== undefined) payload.supplierCode = data.supplierCode;
        if (data.essentialInfo !== undefined) payload.essentialInfo = data.essentialInfo;
        if (data.priceComment !== undefined) payload.priceComment = data.priceComment;
        if (data.supplements !== undefined) payload.supplements = data.supplements;
        if (data.optionalExtras !== undefined) payload.optionalExtras = data.optionalExtras;
        if (data.specialOffers !== undefined) payload.specialOffers = data.specialOffers;
        if (data.rooms !== undefined) payload.rooms = data.rooms;
        if (data.success !== undefined) payload.success = data.success;
        if (data.versionDescription !== undefined) payload.versionDescription = data.versionDescription;
        if (data.expiresAt !== undefined) payload.expiresAt = data.expiresAt;

        return prisma.hotelOptionDetail.upsert({
            where: { tid: data.tid },
            update: payload,
            create: payload,
        });
    }
}

export default new HotelSearchRepository();
