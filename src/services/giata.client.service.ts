/**
 * GIATA API Client Service
 *
 * HTTP client for both GIATA MHG (Multilingual Hotel Guide) and Multicodes APIs.
 * MHG provides: texts, images, fact sheets per hotel.
 * Multicodes provides: property identification, supplier code mappings, geo data.
 *
 * Auth: HTTP Basic with format username|company : password
 * Response: XML → parsed to JS objects via fast-xml-parser
 */

import axios, { AxiosInstance } from 'axios';
import Bottleneck from 'bottleneck';
import { XMLParser } from 'fast-xml-parser';
import config from '../config';
import logger from '../utils/logger';

// ─── XML Parser (shared instance) ───────────────────────────────────────────

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
});

/** Ensure a value is always an array (handles XML nodes that may be single or multiple). */
function toArray<T>(val: T | T[] | undefined | null): T[] {
    if (val == null) return [];
    return Array.isArray(val) ? val : [val];
}

// ─── Rate limiter (conservative: 5 req/sec — no known GIATA limit) ─────────

const limiter = new Bottleneck({
    reservoir: 5,
    reservoirRefreshAmount: 5,
    reservoirRefreshInterval: 1000,
    maxConcurrent: 3,
    minTime: 200,
});

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GiataTextSection {
    sectionType: string;
    title: string;
    content: string;
}

export interface GiataTextResult {
    giataId: string;
    lang: string;
    lastUpdate: string | null;
    sections: GiataTextSection[];
}

export interface GiataImageSize {
    maxwidth: string;
    width: string;
    height: string;
    filesize: string;
    url: string;
}

export interface GiataImage {
    type: string;         // "a"=exterior, "w"=room, "p"=pool, etc.
    lastUpdate: string | null;
    sizes: GiataImageSize[];
}

export interface GiataImageResult {
    giataId: string;
    images: GiataImage[];
}

export interface GiataFactValue {
    value: string;
    unit?: string;
    fee?: boolean;
    name?: string;
}

export interface GiataFact {
    sectionType: string;
    sectionName: string;
    factId: number;
    factName: string;
    typeHint: string;
    values: GiataFactValue[];
}

export interface GiataFactResult {
    giataId: string;
    lastUpdate: string | null;
    facts: GiataFact[];
}

export interface GiataProviderCode {
    providerCode: string;
    providerType: string;
    codeValues: string[];
}

export interface GiataPropertyResult {
    giataId: string;
    name: string;
    city: string;
    country: string;
    lastUpdate: string | null;
    providers: GiataProviderCode[];
    latitude?: number;
    longitude?: number;
    category?: string;
}

export interface GiataListItem {
    giataId: string;
    lastUpdate: string;
}

// ─── Service ────────────────────────────────────────────────────────────────

class GiataClientService {
    private mhgClient: AxiosInstance;
    private multicodesClient: AxiosInstance;

    constructor() {
        const auth = {
            username: config.giata.username,
            password: config.giata.password,
        };

        this.mhgClient = axios.create({
            baseURL: config.giata.mhgBaseUrl,
            auth,
            timeout: 30000,
            headers: { Accept: 'application/xml' },
        });

        this.multicodesClient = axios.create({
            baseURL: config.giata.multicodesBaseUrl,
            auth,
            timeout: 30000,
            headers: { Accept: 'application/xml' },
        });
    }

    /** Check if GIATA credentials are configured. */
    isConfigured(): boolean {
        return !!(config.giata.username && config.giata.password);
    }

    // ─── MHG: Texts ─────────────────────────────────────────────────────

    /** Fetch hotel texts in a given language (e.g. "en", "de"). */
    async getTexts(lang: string, giataId: string): Promise<GiataTextResult | null> {
        try {
            const response = await limiter.schedule(() =>
                this.mhgClient.get(`/texts/${lang}/${giataId}`)
            );
            const parsed = xmlParser.parse(response.data);
            const item = parsed?.result?.item;
            if (!item) return null;

            const text = toArray(item.texts?.text)[0];
            if (!text) return null;

            const sections = toArray(text.sections?.section);

            return {
                giataId: String(item['@_giataId'] ?? giataId),
                lang,
                lastUpdate: text['@_lastUpdate'] ?? null,
                sections: sections.map((s: any) => ({
                    sectionType: String(s['@_type'] ?? ''),
                    title: s.title ?? '',
                    content: s.para ?? '',
                })).filter((s: GiataTextSection) => s.content),
            };
        } catch (err: any) {
            if (err.response?.status === 404 || err.response?.status === 403) return null;
            logger.error({ err: err.message, giataId, lang }, 'GIATA: failed to fetch texts');
            throw err;
        }
    }

    // ─── MHG: Images ────────────────────────────────────────────────────

    /** Fetch all images for a hotel. */
    async getImages(giataId: string): Promise<GiataImageResult | null> {
        try {
            const response = await limiter.schedule(() =>
                this.mhgClient.get(`/images/${giataId}`)
            );
            const parsed = xmlParser.parse(response.data);
            const item = parsed?.result?.item;
            if (!item) return null;

            const images = toArray(item.images?.image);

            return {
                giataId: String(item['@_giataId'] ?? giataId),
                images: images.map((img: any) => {
                    const sizes = toArray(img.sizes?.size);
                    return {
                        type: img['@_type'] ?? 'a',
                        lastUpdate: img['@_lastUpdate'] ?? null,
                        sizes: sizes.map((s: any) => ({
                            maxwidth: String(s['@_maxwidth'] ?? ''),
                            width: String(s['@_width'] ?? ''),
                            height: String(s['@_height'] ?? ''),
                            filesize: String(s['@_filesize'] ?? ''),
                            url: s['@_xlink:href'] ?? '',
                        })),
                    };
                }),
            };
        } catch (err: any) {
            if (err.response?.status === 404 || err.response?.status === 403) return null;
            logger.error({ err: err.message, giataId }, 'GIATA: failed to fetch images');
            throw err;
        }
    }

    // ─── MHG: Fact Sheet ────────────────────────────────────────────────

    /** Fetch structured fact sheet for a hotel. */
    async getFactSheet(giataId: string): Promise<GiataFactResult | null> {
        try {
            const response = await limiter.schedule(() =>
                this.mhgClient.get(`/factsheets/${giataId}`)
            );
            const parsed = xmlParser.parse(response.data);
            const item = parsed?.result?.item;
            if (!item) return null;

            const factsheet = item.factsheet;
            if (!factsheet) return null;

            const sections = toArray(factsheet.sections?.section);

            const facts: GiataFact[] = [];
            for (const section of sections) {
                const sectionType = String(section['@_type'] ?? '');
                const sectionName = section['@_name'] ?? '';
                const factList = toArray(section.facts?.fact);

                for (const f of factList) {
                    const valueList = toArray(f.value);

                    facts.push({
                        sectionType,
                        sectionName,
                        factId: Number(f['@_id'] ?? 0),
                        factName: f['@_name'] ?? '',
                        typeHint: f['@_typeHint'] ?? 'string',
                        values: valueList.map((v: any) => ({
                            value: typeof v === 'object' ? (v['#text'] ?? '') : String(v),
                            unit: typeof v === 'object' ? (v['@_unit'] ?? undefined) : undefined,
                            fee: typeof v === 'object' ? (v['@_fee'] === 'true') : false,
                            name: typeof v === 'object' ? (v['@_name'] ?? undefined) : undefined,
                        })),
                    });
                }
            }

            return {
                giataId: String(item['@_giataId'] ?? giataId),
                lastUpdate: factsheet['@_lastUpdate'] ?? null,
                facts,
            };
        } catch (err: any) {
            if (err.response?.status === 404 || err.response?.status === 403) return null;
            logger.error({ err: err.message, giataId }, 'GIATA: failed to fetch fact sheet');
            throw err;
        }
    }

    // ─── MHG: Changed Items List ────────────────────────────────────────

    /** List GIATA IDs modified since a given date. */
    async getItemsChangedSince(since: string): Promise<GiataListItem[]> {
        try {
            const response = await limiter.schedule(() =>
                this.mhgClient.get(`/items/`, { params: { changedSince: since } })
            );
            const parsed = xmlParser.parse(response.data);
            const list = toArray(parsed?.result?.items?.item);
            return list.map((i: any) => ({
                giataId: String(i['@_giataId'] ?? ''),
                lastUpdate: i['@_lastUpdate'] ?? '',
            }));
        } catch (err: any) {
            logger.error({ err: err.message, since }, 'GIATA: failed to fetch changed items');
            return [];
        }
    }

    // ─── Multicodes: Property Details ───────────────────────────────────

    /** Fetch full property details from Multicodes (address, providers, geo, chains). */
    async getPropertyDetails(giataId: string): Promise<GiataPropertyResult | null> {
        try {
            const response = await limiter.schedule(() =>
                this.multicodesClient.get(`/properties/${giataId}`)
            );
            const parsed = xmlParser.parse(response.data);
            const property = parsed?.properties?.property;
            if (!property) return null;

            // Parse provider codes
            const providerList = toArray(property.propertyCodes?.provider);

            const providers: GiataProviderCode[] = [];
            for (const p of providerList) {
                const codes = toArray(p.code);
                for (const c of codes) {
                    const values = toArray(c.value);
                    const codeValues = values.map((v: any) =>
                        typeof v === 'object' ? (v['#text'] ?? '') : String(v)
                    ).filter(Boolean);

                    if (codeValues.length > 0) {
                        providers.push({
                            providerCode: p['@_providerCode'] ?? '',
                            providerType: p['@_providerType'] ?? '',
                            codeValues,
                        });
                    }
                }
            }

            // Parse geo codes
            const geoCode = property.geoCodes?.geoCode;
            const lat = geoCode?.latitude ? Number(geoCode.latitude) : undefined;
            const lng = geoCode?.longitude ? Number(geoCode.longitude) : undefined;

            // Parse rating
            const ratings = toArray(property.ratings?.rating);
            const defaultRating = ratings.find((r: any) => r['@_isDefault'] === 'true') ?? ratings[0];
            const category = defaultRating?.['@_value'] ?? property.category ?? undefined;

            return {
                giataId: String(property['@_giataId'] ?? giataId),
                name: property.name ?? '',
                city: typeof property.city === 'object' ? (property.city['#text'] ?? '') : (property.city ?? ''),
                country: property.country ?? '',
                lastUpdate: property['@_lastUpdate'] ?? null,
                providers,
                latitude: lat,
                longitude: lng,
                category: category ? String(category) : undefined,
            };
        } catch (err: any) {
            // 301 = moved property
            if (err.response?.status === 301) {
                const errorXml = err.response?.data;
                if (errorXml) {
                    const parsed = xmlParser.parse(errorXml);
                    const newUrl = parsed?.error?.description?.['@_xlink:href'] ?? '';
                    const newGiataId = newUrl.split('/').pop();
                    if (newGiataId) {
                        logger.info({ oldGiataId: giataId, newGiataId }, 'GIATA: property moved (301)');
                        return this.getPropertyDetails(newGiataId);
                    }
                }
            }
            if (err.response?.status === 404) return null;
            logger.error({ err: err.message, giataId }, 'GIATA: failed to fetch property details');
            throw err;
        }
    }

    // ─── Multicodes: Moved Properties ───────────────────────────────────

    /** Get list of properties that have been moved/merged since a date. */
    async getMovedProperties(since?: string): Promise<Array<{ oldGiataId: string; newGiataId: string; movedOn: string }>> {
        try {
            const url = since
                ? `/properties/moved/since/${since}`
                : '/properties/moved/';
            const response = await limiter.schedule(() =>
                this.multicodesClient.get(url)
            );
            const parsed = xmlParser.parse(response.data);
            const list = toArray(parsed?.properties?.property);
            return list.map((p: any) => ({
                oldGiataId: String(p['@_giataId'] ?? ''),
                newGiataId: String(p['@_movedTo'] ?? ''),
                movedOn: p['@_movedOn'] ?? '',
            })).filter((m: any) => m.oldGiataId && m.newGiataId);
        } catch (err: any) {
            logger.error({ err: err.message, since }, 'GIATA: failed to fetch moved properties');
            return [];
        }
    }

    // ─── Multicodes: Resolve by Supplier Code ───────────────────────────

    /** Try to find a GIATA ID by looking up a supplier/GDS code in Multicodes. */
    async resolveByGds(providerCode: string, hotelCode: string): Promise<string | null> {
        try {
            const response = await limiter.schedule(() =>
                this.multicodesClient.get(`/properties/gds/${providerCode}/${hotelCode}`)
            );
            const parsed = xmlParser.parse(response.data);
            const properties = toArray(parsed?.properties?.property);
            if (properties.length === 0) return null;

            const id = properties[0]?.['@_giataId'];
            return id ? String(id) : null;
        } catch (err: any) {
            if (err.response?.status === 404) return null;
            logger.warn({ err: err.message, providerCode, hotelCode }, 'GIATA: resolve by GDS failed');
            return null;
        }
    }

    /**
     * Fetch a GIATA image binary using Basic Auth credentials.
     * Used by the backend proxy endpoint `GET /api/v1/hotels/giata-image`.
     *
     * Only accepts URLs on the ghgml.giatamedia.com host to prevent SSRF.
     * Returns null on auth / network / not-found failures.
     */
    async fetchImage(imageUrl: string): Promise<{ data: Buffer; contentType: string } | null> {
        if (!this.isConfigured()) return null;

        // SSRF guard — allow only GIATA's image host.
        let host: string;
        try {
            host = new URL(imageUrl).hostname;
        } catch {
            return null;
        }
        if (host !== 'ghgml.giatamedia.com') return null;

        try {
            const response = await axios.get(imageUrl, {
                auth: {
                    username: config.giata.username!,
                    password: config.giata.password!,
                },
                responseType: 'arraybuffer',
                timeout: 15000,
            });
            return {
                data: Buffer.from(response.data),
                contentType: response.headers['content-type'] ?? 'image/jpeg',
            };
        } catch (err: any) {
            if (err?.response?.status === 404) return null;
            logger.warn({ err: err.message, imageUrl }, 'GIATA: fetchImage failed');
            return null;
        }
    }
}

export default new GiataClientService();
