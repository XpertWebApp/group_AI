/**
 * GIATA Repository
 *
 * Database operations for GIATA hotel content:
 * - HotelGiataText (multilingual descriptions)
 * - HotelGiataFact (structured fact sheets)
 * - HotelGiataImage (image URLs)
 * - HotelGiataMapping (supplier code mappings)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class GiataRepository {

    // ─── Texts ──────────────────────────────────────────────────────────

    async upsertTexts(hotelCode: string, giataId: string, texts: Array<{
        lang: string;
        sectionType: string;
        title: string;
        content: string;
        lastUpdate?: string | null;
    }>): Promise<void> {
        for (const t of texts) {
            await prisma.hotelGiataText.upsert({
                where: {
                    hotelCode_lang_sectionType: {
                        hotelCode,
                        lang: t.lang,
                        sectionType: t.sectionType,
                    },
                },
                update: {
                    giataId,
                    title: t.title,
                    content: t.content,
                    lastUpdate: t.lastUpdate ? new Date(t.lastUpdate) : null,
                    syncedAt: new Date(),
                },
                create: {
                    hotelCode,
                    giataId,
                    lang: t.lang,
                    sectionType: t.sectionType,
                    title: t.title,
                    content: t.content,
                    lastUpdate: t.lastUpdate ? new Date(t.lastUpdate) : null,
                },
            });
        }
    }

    async getTexts(hotelCode: string, lang?: string) {
        return prisma.hotelGiataText.findMany({
            where: { hotelCode, ...(lang ? { lang } : {}) },
            orderBy: { sectionType: 'asc' },
        });
    }

    // ─── Facts ──────────────────────────────────────────────────────────

    async upsertFacts(hotelCode: string, giataId: string, facts: Array<{
        sectionType: string;
        sectionName: string;
        factId: number;
        factName: string;
        typeHint: string;
        value: string;
        unit?: string;
        fee?: boolean;
    }>): Promise<void> {
        for (const f of facts) {
            await prisma.hotelGiataFact.upsert({
                where: {
                    hotelCode_factId: {
                        hotelCode,
                        factId: f.factId,
                    },
                },
                update: {
                    giataId,
                    sectionType: f.sectionType,
                    sectionName: f.sectionName,
                    factName: f.factName,
                    typeHint: f.typeHint,
                    value: String(f.value),
                    unit: f.unit ?? null,
                    fee: f.fee ?? false,
                    syncedAt: new Date(),
                },
                create: {
                    hotelCode,
                    giataId,
                    sectionType: f.sectionType,
                    sectionName: f.sectionName,
                    factId: f.factId,
                    factName: f.factName,
                    typeHint: f.typeHint,
                    value: String(f.value),
                    unit: f.unit ?? null,
                    fee: f.fee ?? false,
                },
            });
        }
    }

    async getFacts(hotelCode: string) {
        return prisma.hotelGiataFact.findMany({
            where: { hotelCode },
            orderBy: [{ sectionType: 'asc' }, { factId: 'asc' }],
        });
    }

    // ─── Images ─────────────────────────────────────────────────────────

    async upsertImages(hotelCode: string, giataId: string, images: Array<{
        imageType: string;
        displayOrder: number;
        urlSmall?: string;
        urlMedium?: string;
        urlLarge?: string;
        urlFullHd?: string;
        urlOriginal?: string;
        lastUpdate?: string | null;
    }>): Promise<void> {
        // Delete existing images for this hotel and re-insert (simpler than complex upsert logic)
        await prisma.hotelGiataImage.deleteMany({ where: { hotelCode } });

        if (images.length > 0) {
            await prisma.hotelGiataImage.createMany({
                data: images.map((img) => ({
                    hotelCode,
                    giataId,
                    imageType: img.imageType,
                    displayOrder: img.displayOrder,
                    urlSmall: img.urlSmall ?? null,
                    urlMedium: img.urlMedium ?? null,
                    urlLarge: img.urlLarge ?? null,
                    urlFullHd: img.urlFullHd ?? null,
                    urlOriginal: img.urlOriginal ?? null,
                    lastUpdate: img.lastUpdate ? new Date(img.lastUpdate) : null,
                })),
            });
        }
    }

    async getImages(hotelCode: string) {
        return prisma.hotelGiataImage.findMany({
            where: { hotelCode },
            orderBy: { displayOrder: 'asc' },
        });
    }

    // ─── Mappings ───────────────────────────────────────────────────────

    async upsertMappings(hotelCode: string, giataId: string, mappings: Array<{
        providerCode: string;
        providerType: string;
        codeValue: string;
    }>): Promise<void> {
        for (const m of mappings) {
            await prisma.hotelGiataMapping.upsert({
                where: {
                    hotelCode_providerCode_codeValue: {
                        hotelCode,
                        providerCode: m.providerCode,
                        codeValue: m.codeValue,
                    },
                },
                update: {
                    giataId,
                    providerType: m.providerType,
                    syncedAt: new Date(),
                },
                create: {
                    hotelCode,
                    giataId,
                    providerCode: m.providerCode,
                    providerType: m.providerType,
                    codeValue: m.codeValue,
                },
            });
        }
    }

    async getMappings(hotelCode: string) {
        return prisma.hotelGiataMapping.findMany({
            where: { hotelCode },
            orderBy: { providerCode: 'asc' },
        });
    }

    // ─── Hotel Queries ──────────────────────────────────────────────────

    /** Get hotels that have a giataCode populated (candidates for GIATA sync). */
    async getHotelsWithGiataCode(opts?: { limit?: number; offset?: number }) {
        return prisma.hotel.findMany({
            where: { giataCode: { not: null } },
            select: { hotelCode: true, giataCode: true, name: true, supplierCode: true },
            take: opts?.limit ?? 500,
            skip: opts?.offset ?? 0,
            orderBy: { hotelCode: 'asc' },
        });
    }

    /** Get hotels without giataCode but with a supplierCode (for Multicodes resolution). */
    async getHotelsWithoutGiataCode(opts?: { limit?: number }) {
        return prisma.hotel.findMany({
            where: {
                giataCode: null,
                supplierCode: { not: null },
            },
            select: { hotelCode: true, supplierCode: true, name: true },
            take: opts?.limit ?? 200,
            orderBy: { hotelCode: 'asc' },
        });
    }

    /** Count hotels by GIATA sync status. */
    async getGiataStatusCounts(): Promise<Record<string, number>> {
        const results = await prisma.$queryRawUnsafe<Array<{ status: string | null; count: bigint }>>(
            `SELECT giata_status AS status, COUNT(*)::int AS count FROM master.hotels GROUP BY giata_status`
        );
        const counts: Record<string, number> = {};
        for (const r of results) {
            counts[r.status ?? 'no_status'] = Number(r.count);
        }
        return counts;
    }

    // ─── Sync Job Management ──────────────────────────────────────────

    async createSyncJob(type: string, totalRecords?: number) {
        return prisma.syncJob.create({
            data: {
                type,
                status: 'IN_PROGRESS',
                totalRecords: totalRecords ?? null,
                startedAt: new Date(),
            },
        });
    }

    async updateSyncJob(id: string, data: any) {
        return prisma.syncJob.update({ where: { id }, data });
    }

    async getInProgressJob(type: string) {
        return prisma.syncJob.findFirst({
            where: { type, status: 'IN_PROGRESS' },
            orderBy: { startedAt: 'desc' },
        });
    }

    async getLatestJob(type: string) {
        return prisma.syncJob.findFirst({
            where: { type },
            orderBy: { startedAt: 'desc' },
        });
    }

    /** Count hotels with giataCode for total records tracking. */
    async countHotelsWithGiataCode(): Promise<number> {
        return prisma.hotel.count({ where: { giataCode: { not: null } } });
    }

    /** Update GIATA sync status on a hotel. */
    async updateGiataStatus(hotelCode: string, status: string, giataCode?: string): Promise<void> {
        const data: any = {
            giataStatus: status,
            giataSyncedAt: new Date(),
        };
        if (giataCode !== undefined) {
            data.giataCode = giataCode;
        }
        await prisma.hotel.update({
            where: { hotelCode },
            data,
        });
    }
}

export default new GiataRepository();
