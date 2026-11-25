/**
 * Resolve hotel images for PDF rendering.
 *
 * The offer PDF is delivered to customers via email — the recipient's PDF
 * viewer must not need any network access to render images. So we
 * pre-fetch every hotel's thumbnail in `buildPdfData()`, base64-encode
 * it, and embed it inline as a `data:image/jpeg;base64,...` URI in the
 * HTML Puppeteer renders.
 *
 * Source priority mirrors the FE's Hotel Card fallback chain:
 *   1. GIATA images (`HotelGiataImage`) — authoritative, branded
 *      exterior / room / lobby photos. Sorted by Oliver's priority
 *      (exterior first). Fetched via `giataClientService.fetchImage`.
 *   2. WBE imageKeys (`HotelImage`) — fallback. Many WBE keys on UAT
 *      currently return a generic "HOTEL" placeholder image; we hash
 *      every WBE response against a known placeholder set so we don't
 *      embed those.
 *
 * Failure modes — all graceful, never throw:
 *   - hotel has no GIATA rows and no WBE keys     → return null
 *   - every GIATA URL 404s / auth fails           → fall through to WBE
 *   - every WBE key 404s / returns placeholder    → return null
 *   - encoding throws                              → return null + log
 *
 * The PDF hotel block renders without a thumbnail when this returns
 * null; legacy proposals never accumulate broken-image placeholders.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { Jimp } from 'jimp';
import logger from './logger';
import wbeClientService from '../services/wbe.client.service';
import giataClientService from '../services/giata.client.service';
import { sortGiataImagesByPriority } from '../config/imagePriority';

const prisma = new PrismaClient();

/**
 * Thumbnail sizing for inlined PDF images. The hotel card renders the
 * image at ~160 px wide, so we downscale any large original to at most
 * THUMBNAIL_MAX_WIDTH px (crisp for print) and re-encode as JPEG before
 * embedding. This keeps the PDF small AND guarantees an image is never
 * DROPPED just for being large — hotels whose WBE/GIATA photos are 3–5 MB
 * full-res JPEGs (e.g. Hotel Gracery Seoul) now still show a photo.
 */
const THUMBNAIL_MAX_WIDTH = 500;
/** Only pay the resize cost for images bigger than this (small ones pass through). */
const DOWNSCALE_OVER_BYTES = 120_000;
/**
 * Hard sanity ceiling — reject a response bigger than this outright (before
 * handing it to Jimp) so a broken/huge payload can't OOM the resize step.
 */
const HARD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Cross-request in-memory cache of resolved thumbnails, keyed by hotelCode.
 * A hotel's photo is effectively static, but it was re-fetched on EVERY PDF
 * generation (preview + download + re-download). Those network round-trips to
 * the flaky WBE/GIATA hosts are the dominant cost of PDF generation (observed
 * 15–23 s for a handful of hotels). Caching — including negative results —
 * makes repeat renders instant. In-memory by design: shared across requests
 * in the process, cleared on restart.
 */
const IMAGE_CACHE_OK_TTL_MS = 6 * 60 * 60 * 1000; // 6 h for a resolved image
const IMAGE_CACHE_MISS_TTL_MS = 10 * 60 * 1000;   // 10 min for a null (lets transient WBE/GIATA outages recover)
const imageCache = new Map<string, { uri: string | null; expires: number }>();

/**
 * Per-hotel wall-clock cap so one slow/hanging host can never stall the whole
 * PDF. A hotel that can't resolve an image in time simply renders without a
 * thumbnail (images are non-essential) and is cached as a short-lived miss.
 */
const PER_HOTEL_IMAGE_BUDGET_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; resolve(fallback); }
        }, ms);
        p.then((v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } })
            .catch(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallback); } });
    });
}

/**
 * Known WBE placeholder SHA-256 hashes. When the WBE CDN can't serve a
 * given imageKey (e.g. unauthenticated UAT requests), it returns the
 * same generic "HOTEL" stock image for every request. Embedding that
 * in customer PDFs would look identical for every hotel — worse than
 * showing no image at all. We hash every WBE response and skip these.
 *
 * Add new hashes here when more placeholders are observed in the wild.
 */
const KNOWN_WBE_PLACEHOLDER_HASHES = new Set<string>([
    // 75 928-byte PNG returned for unauthenticated UAT image requests
    'd8e59c653b497af5a36a86b45d046d4e0539cb52e2940da81518d45b3a6a7ea1',
]);

/**
 * One GIATA URL row + its known size variants, picked from the DB in
 * SIZE-ASCENDING order. PDF thumbs are rendered at 90×70 px, so a
 * 4K original would just bloat the PDF without visual gain. We start
 * from the smallest variant and only walk up if a smaller one is
 * missing.
 *
 * GIATA URL sizes (per their docs / DB schema):
 *   urlSmall   ~74 px wide
 *   urlMedium  ~320 px wide
 *   urlLarge   ~800 px wide       ← best fit for 90×70 thumb @ 2× HiDPI
 *   urlFullHd  ~1920 px wide
 *   urlOriginal ~3840 px wide
 */
function pickGiataSizes(row: {
    urlOriginal: string | null;
    urlFullHd: string | null;
    urlLarge: string | null;
    urlMedium: string | null;
    urlSmall: string | null;
}): string[] {
    return [row.urlMedium, row.urlLarge, row.urlSmall, row.urlFullHd, row.urlOriginal]
        .filter((u): u is string => !!u);
}

/**
 * One hotel's image candidates, in fetch order. GIATA URLs first,
 * then WBE keys. Resolved against the master schema with two parallel
 * queries (one per table) keyed by the full hotelCode set.
 */
interface HotelImageCandidates {
    giataUrls: string[];   // raw GIATA URLs — ghgml.giatamedia.com / i.giatamedia.com
    wbeKeys: string[];     // raw WBE imageKey tokens (still URL-encoded as stored)
}

async function loadCandidates(hotelCodes: string[]): Promise<Map<string, HotelImageCandidates>> {
    const out = new Map<string, HotelImageCandidates>();
    if (hotelCodes.length === 0) return out;

    for (const code of hotelCodes) out.set(code, { giataUrls: [], wbeKeys: [] });

    // One query per table — Prisma `IN` clauses make this fast for any
    // proposal-sized hotel set (typically ≤ 5).
    const [giataRows, wbeRows] = await Promise.all([
        prisma.hotelGiataImage.findMany({
            where: { hotelCode: { in: hotelCodes } },
            select: {
                hotelCode: true,
                imageType: true,
                displayOrder: true,
                urlOriginal: true,
                urlFullHd: true,
                urlLarge: true,
                urlMedium: true,
                urlSmall: true,
            },
        }),
        prisma.hotelImage.findMany({
            where: { hotelCode: { in: hotelCodes } },
            select: { hotelCode: true, imageKey: true, displayOrder: true },
            orderBy: [{ hotelCode: 'asc' }, { displayOrder: 'asc' }],
        }),
    ]);

    // GIATA: group by hotelCode, sort by Oliver's exterior-first priority
    // (same ordering the FE Add-Hotel card walks), then flatten to a
    // size-prioritised URL list per hotel.
    const giataByHotel = new Map<string, typeof giataRows>();
    for (const row of giataRows) {
        const list = giataByHotel.get(row.hotelCode) ?? [];
        list.push(row);
        giataByHotel.set(row.hotelCode, list);
    }
    for (const [code, rows] of giataByHotel) {
        const sorted = sortGiataImagesByPriority(rows);
        const urls: string[] = [];
        for (const row of sorted) {
            urls.push(...pickGiataSizes(row));
        }
        out.get(code)!.giataUrls = urls;
    }

    // WBE: ordered by displayOrder per hotel, post-filter empty keys.
    //
    // CRITICAL — `HotelImage.imageKey` is stored URL-encoded (e.g. trailing
    // `%3D` instead of `=`). WBE's content CDN treats the two forms as
    // DIFFERENT keys: the encoded form returns a 75928-byte placeholder
    // PNG, the decoded form returns the real image. The image-proxy route
    // (`/api/v1/hotels/image?key=...`) gets the decoded form automatically
    // because Express parses the query string. The PDF fetcher reads from
    // the DB directly, so we must decode here ourselves before handing
    // the key to `wbeClientService.getHotelImage()`. Without this decode,
    // every WBE call returns the placeholder.
    for (const row of wbeRows) {
        const raw = row.imageKey?.trim();
        if (!raw) continue;
        let decoded = raw;
        try { decoded = decodeURIComponent(raw); } catch { /* use raw if not valid percent-encoding */ }
        out.get(row.hotelCode)!.wbeKeys.push(decoded);
    }

    return out;
}

/**
 * Reasons a fetched response can be unusable. The caller distinguishes
 * "placeholder" (this hotel returns the same fake image for every key —
 * stop walking, save time) from "transient" (this one response is junk
 * but other keys might still work — keep walking).
 */
type ImageReject = 'empty' | 'oversize' | 'placeholder' | 'not-image' | null;

/** PNG magic: 89 50 4E 47 0D 0A 1A 0A */
function isPngMagic(buf: Buffer): boolean {
    return buf.length >= 8
        && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
        && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
}

/** JPEG magic: FF D8 FF */
function isJpegMagic(buf: Buffer): boolean {
    return buf.length >= 3
        && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

/**
 * Validate a fetched response as a real, usable image. WBE in particular
 * is known to return:
 *   - 111-byte XML responses ("<?xml ... AccessDenied ...") with
 *     `Content-Type: image/png`. Magic-number check rejects these.
 *   - The 75 928-byte placeholder PNG for keys it can't serve. Hash
 *     check catches these.
 *   - 8 MB 4K hero shots for some keys. Size cap rejects these.
 * Returns null on accept, or the specific reason on reject.
 */
function validateImage(buf: Buffer): ImageReject {
    if (!buf || buf.byteLength === 0) return 'empty';
    if (!isPngMagic(buf) && !isJpegMagic(buf)) return 'not-image';
    // Only reject absurdly huge payloads (Jimp OOM guard). Normal large
    // photos (3–5 MB) are accepted and downscaled in toDataUri so the image
    // is never dropped for being big.
    if (buf.byteLength > HARD_MAX_BYTES) return 'oversize';
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (KNOWN_WBE_PLACEHOLDER_HASHES.has(hash)) return 'placeholder';
    return null;
}

/**
 * Convert a fetched image to a base64 data URI, downscaling large originals
 * to a THUMBNAIL_MAX_WIDTH-px JPEG first. Small images pass through as-is.
 * On any resize error we fall back to embedding the original bytes — better
 * a big image than no image (the whole point of this path).
 */
async function toDataUri(result: { data: Buffer; contentType: string }): Promise<string> {
    let buf = result.data;
    let contentType = result.contentType || 'image/jpeg';
    if (buf.byteLength > DOWNSCALE_OVER_BYTES) {
        try {
            const img = await Jimp.read(buf);
            if (img.width > THUMBNAIL_MAX_WIDTH) {
                img.resize({ w: THUMBNAIL_MAX_WIDTH }); // keeps aspect ratio
            }
            buf = await img.getBuffer('image/jpeg');
            contentType = 'image/jpeg';
        } catch (err: any) {
            logger.warn({ err: err?.message }, 'thumbnail downscale failed — embedding original');
        }
    }
    return `data:${contentType};base64,${buf.toString('base64')}`;
}

/**
 * Try the GIATA candidate URLs in order. First one that authenticates,
 * resolves, AND passes validation wins. Returns null if every URL
 * fails — caller falls through to WBE.
 */
async function tryGiata(urls: string[]): Promise<string | null> {
    for (const url of urls) {
        try {
            const result = await giataClientService.fetchImage(url);
            if (!result) continue;
            const reject = validateImage(result.data);
            if (reject !== null) {
                logger.debug({ reject, url }, 'GIATA image rejected');
                continue;
            }
            return await toDataUri(result);
        } catch (err: any) {
            logger.warn(
                { err: err?.message, url },
                'GIATA image fetch threw — trying next candidate',
            );
        }
    }
    return null;
}

/**
 * Try the WBE imageKey list in order. First passing key wins.
 *
 * Streak limit applies ONLY to placeholder rejections: WBE returns the
 * same generic 75 928-byte PNG for every key of a no-image hotel, so
 * two consecutive placeholders is a clear signal that walking the
 * remaining ~58 keys is wasted time. Other rejections (oversize 4K
 * shots, AccessDenied XML wearing image/png, transient 5xx) keep
 * walking — they're per-key issues, not per-hotel.
 *
 * Hard ceiling: walk at most MAX_WBE_KEYS keys regardless of result.
 * Stops a pathological case where every key returns junk-but-different
 * from blocking the PDF for 60s.
 */
async function tryWbe(keys: string[]): Promise<string | null> {
    const STREAK_LIMIT = 2;
    // Tight ceiling — WBE fetches are 1-2 s each on UAT. Beyond ~8 walks
    // we're already past the budget for a 5-hotel PDF render. Most real
    // hotels either succeed in the first 1-3 keys or never succeed.
    const MAX_WBE_KEYS = 8;
    let placeholderStreak = 0;
    let tried = 0;

    for (const key of keys) {
        if (tried >= MAX_WBE_KEYS) {
            logger.debug({ tried, totalKeys: keys.length }, 'WBE max-keys ceiling reached — stopping walk');
            break;
        }
        tried += 1;
        try {
            const result = await wbeClientService.getHotelImage(key);
            if (!result) { placeholderStreak = 0; continue; }

            const reject = validateImage(result.data);
            if (reject === null) {
                return await toDataUri(result);
            }

            if (reject === 'placeholder') {
                placeholderStreak += 1;
                logger.debug(
                    { keyHead: key.slice(0, 24) + '...', placeholderStreak },
                    'WBE returned known placeholder hash',
                );
                if (placeholderStreak >= STREAK_LIMIT) {
                    logger.debug(
                        { triedKeys: tried, totalKeys: keys.length },
                        'WBE placeholder streak limit reached — stopping walk',
                    );
                    break;
                }
            } else {
                // not-image / oversize / empty — reset the placeholder
                // streak so a stray bad response in the middle of real
                // keys doesn't make us quit early.
                placeholderStreak = 0;
                logger.debug(
                    { reject, keyHead: key.slice(0, 24) + '...' },
                    'WBE image rejected (non-placeholder reason) — continuing walk',
                );
            }
        } catch (err: any) {
            placeholderStreak = 0;
            logger.warn(
                { err: err?.message, keyHead: key.slice(0, 24) + '...' },
                'WBE image fetch threw — trying next candidate',
            );
        }
    }
    return null;
}

/**
 * Resolve a `hotelCode -> dataUri | null` map for every hotel in a
 * proposal in ONE parallel pass. Used by `buildPdfData()`.
 *
 * Designed to be cheap on the happy path and bulletproof on the sad one:
 *  - one parallel DB hit pulls every hotel's GIATA + WBE candidates
 *  - hotels fan out in parallel (no serial waterfall across hotels)
 *  - per-hotel candidates walk serially through GIATA → WBE
 *  - per-candidate try/catch — one bad URL never breaks the others
 *  - returns the map regardless; callers decide per-hotel whether the
 *    URI is present
 */
export async function resolveHotelImagesForPdf(
    hotelCodes: string[],
): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (hotelCodes.length === 0) return result;

    const dedupedCodes = Array.from(new Set(hotelCodes.filter(Boolean)));
    const now = Date.now();

    // Serve fresh cache hits immediately; only hit the network for misses.
    const toFetch: string[] = [];
    for (const code of dedupedCodes) {
        const hit = imageCache.get(code);
        if (hit && hit.expires > now) {
            result.set(code, hit.uri);
        } else {
            toFetch.push(code);
        }
    }
    if (toFetch.length === 0) return result;

    const candidatesByCode = await loadCandidates(toFetch);

    await Promise.all(
        toFetch.map(async (code) => {
            // Per-hotel budget: a slow/hanging host can never stall the PDF.
            const uri = await withTimeout(
                resolveOneHotelImage(code, candidatesByCode.get(code)),
                PER_HOTEL_IMAGE_BUDGET_MS,
                null,
            );
            imageCache.set(code, {
                uri,
                expires: Date.now() + (uri ? IMAGE_CACHE_OK_TTL_MS : IMAGE_CACHE_MISS_TTL_MS),
            });
            result.set(code, uri);
        }),
    );

    return result;
}

/**
 * Resolve a single hotel's thumbnail: GIATA first (what the FE shows), then
 * WBE fallback. Returns null if neither source yields a usable image.
 */
async function resolveOneHotelImage(
    code: string,
    candidates: HotelImageCandidates | undefined,
): Promise<string | null> {
    if (!candidates) return null;

    const fromGiata = await tryGiata(candidates.giataUrls);
    if (fromGiata) return fromGiata;

    const fromWbe = await tryWbe(candidates.wbeKeys);
    if (fromWbe) return fromWbe;

    logger.debug(
        { hotelCode: code, giataCount: candidates.giataUrls.length, wbeCount: candidates.wbeKeys.length },
        'No usable hotel image after GIATA + WBE fallback',
    );
    return null;
}
