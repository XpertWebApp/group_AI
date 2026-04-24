"use strict";
/**
 * GIATA Repository
 *
 * Database operations for GIATA hotel content:
 * - HotelGiataText (multilingual descriptions)
 * - HotelGiataFact (structured fact sheets)
 * - HotelGiataImage (image URLs)
 * - HotelGiataMapping (supplier code mappings)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GiataRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class GiataRepository {
    // ─── Texts ──────────────────────────────────────────────────────────
    async upsertTexts(hotelCode, giataId, texts) {
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
    async getTexts(hotelCode, lang) {
        return prisma.hotelGiataText.findMany({
            where: { hotelCode, ...(lang ? { lang } : {}) },
            orderBy: { sectionType: 'asc' },
        });
    }
    // ─── Facts ──────────────────────────────────────────────────────────
    async upsertFacts(hotelCode, giataId, facts) {
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
    async getFacts(hotelCode) {
        return prisma.hotelGiataFact.findMany({
            where: { hotelCode },
            orderBy: [{ sectionType: 'asc' }, { factId: 'asc' }],
        });
    }
    // ─── Images ─────────────────────────────────────────────────────────
    async upsertImages(hotelCode, giataId, images) {
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
    async getImages(hotelCode) {
        return prisma.hotelGiataImage.findMany({
            where: { hotelCode },
            orderBy: { displayOrder: 'asc' },
        });
    }
    // ─── Mappings ───────────────────────────────────────────────────────
    async upsertMappings(hotelCode, giataId, mappings) {
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
    async getMappings(hotelCode) {
        return prisma.hotelGiataMapping.findMany({
            where: { hotelCode },
            orderBy: { providerCode: 'asc' },
        });
    }
    // ─── Hotel Queries ──────────────────────────────────────────────────
    /** Get hotels that have a giataCode populated (candidates for GIATA sync). */
    async getHotelsWithGiataCode(opts) {
        return prisma.hotel.findMany({
            where: { giataCode: { not: null } },
            select: { hotelCode: true, giataCode: true, name: true, supplierCode: true },
            take: opts?.limit ?? 500,
            skip: opts?.offset ?? 0,
            orderBy: { hotelCode: 'asc' },
        });
    }
    /** Get hotels without giataCode but with a supplierCode (for Multicodes resolution). */
    async getHotelsWithoutGiataCode(opts) {
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
    async getGiataStatusCounts() {
        const results = await prisma.$queryRawUnsafe(`SELECT giata_status AS status, COUNT(*)::int AS count FROM master.hotels GROUP BY giata_status`);
        const counts = {};
        for (const r of results) {
            counts[r.status ?? 'no_status'] = Number(r.count);
        }
        return counts;
    }
    // ─── Sync Job Management ──────────────────────────────────────────
    async createSyncJob(type, totalRecords) {
        return prisma.syncJob.create({
            data: {
                type,
                status: 'IN_PROGRESS',
                totalRecords: totalRecords ?? null,
                startedAt: new Date(),
            },
        });
    }
    async updateSyncJob(id, data) {
        return prisma.syncJob.update({ where: { id }, data });
    }
    async getInProgressJob(type) {
        return prisma.syncJob.findFirst({
            where: { type, status: 'IN_PROGRESS' },
            orderBy: { startedAt: 'desc' },
        });
    }
    async getLatestJob(type) {
        return prisma.syncJob.findFirst({
            where: { type },
            orderBy: { startedAt: 'desc' },
        });
    }
    /** Count hotels with giataCode for total records tracking. */
    async countHotelsWithGiataCode() {
        return prisma.hotel.count({ where: { giataCode: { not: null } } });
    }
    /** Update GIATA sync status on a hotel. */
    async updateGiataStatus(hotelCode, status, giataCode) {
        const data = {
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
exports.GiataRepository = GiataRepository;
exports.default = new GiataRepository();
