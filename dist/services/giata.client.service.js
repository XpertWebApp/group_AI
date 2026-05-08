"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const bottleneck_1 = __importDefault(require("bottleneck"));
const fast_xml_parser_1 = require("fast-xml-parser");
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../utils/logger"));
// ─── XML Parser (shared instance) ───────────────────────────────────────────
const xmlParser = new fast_xml_parser_1.XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
});
/** Ensure a value is always an array (handles XML nodes that may be single or multiple). */
function toArray(val) {
    if (val == null)
        return [];
    return Array.isArray(val) ? val : [val];
}
// ─── Rate limiter (conservative: 5 req/sec — no known GIATA limit) ─────────
const limiter = new bottleneck_1.default({
    reservoir: 5,
    reservoirRefreshAmount: 5,
    reservoirRefreshInterval: 1000,
    maxConcurrent: 3,
    minTime: 200,
});
// ─── Service ────────────────────────────────────────────────────────────────
class GiataClientService {
    constructor() {
        const auth = {
            username: config_1.default.giata.username,
            password: config_1.default.giata.password,
        };
        this.mhgClient = axios_1.default.create({
            baseURL: config_1.default.giata.mhgBaseUrl,
            auth,
            timeout: 30000,
            headers: { Accept: 'application/xml' },
        });
        this.multicodesClient = axios_1.default.create({
            baseURL: config_1.default.giata.multicodesBaseUrl,
            auth,
            timeout: 30000,
            headers: { Accept: 'application/xml' },
        });
    }
    /** Check if GIATA credentials are configured. */
    isConfigured() {
        return !!(config_1.default.giata.username && config_1.default.giata.password);
    }
    // ─── MHG: Texts ─────────────────────────────────────────────────────
    /** Fetch hotel texts in a given language (e.g. "en", "de"). */
    async getTexts(lang, giataId) {
        try {
            const response = await limiter.schedule(() => this.mhgClient.get(`/texts/${lang}/${giataId}`));
            const parsed = xmlParser.parse(response.data);
            const item = parsed?.result?.item;
            if (!item)
                return null;
            const text = toArray(item.texts?.text)[0];
            if (!text)
                return null;
            const sections = toArray(text.sections?.section);
            return {
                giataId: String(item['@_giataId'] ?? giataId),
                lang,
                lastUpdate: text['@_lastUpdate'] ?? null,
                sections: sections.map((s) => ({
                    sectionType: String(s['@_type'] ?? ''),
                    title: s.title ?? '',
                    content: s.para ?? '',
                })).filter((s) => s.content),
            };
        }
        catch (err) {
            if (err.response?.status === 404)
                return null;
            if (err.response?.status === 403) {
                // 403 = account is not entitled to this language. Log loudly
                // (once per lang would be nicer, but this runs in a tight sync
                // loop and we want every operator to notice if a sync silently
                // skips a whole language).
                logger_1.default.warn({ giataId, lang }, 'GIATA: 403 Forbidden on /texts — account likely lacks entitlement for this language');
                return null;
            }
            logger_1.default.error({ err: err.message, giataId, lang }, 'GIATA: failed to fetch texts');
            throw err;
        }
    }
    // ─── MHG: Images ────────────────────────────────────────────────────
    /** Fetch all images for a hotel. */
    async getImages(giataId) {
        try {
            const response = await limiter.schedule(() => this.mhgClient.get(`/images/${giataId}`));
            const parsed = xmlParser.parse(response.data);
            const item = parsed?.result?.item;
            if (!item)
                return null;
            const images = toArray(item.images?.image);
            return {
                giataId: String(item['@_giataId'] ?? giataId),
                images: images.map((img) => {
                    const sizes = toArray(img.sizes?.size);
                    return {
                        type: img['@_type'] ?? 'a',
                        lastUpdate: img['@_lastUpdate'] ?? null,
                        sizes: sizes.map((s) => ({
                            maxwidth: String(s['@_maxwidth'] ?? ''),
                            width: String(s['@_width'] ?? ''),
                            height: String(s['@_height'] ?? ''),
                            filesize: String(s['@_filesize'] ?? ''),
                            url: s['@_xlink:href'] ?? '',
                        })),
                    };
                }),
            };
        }
        catch (err) {
            if (err.response?.status === 404 || err.response?.status === 403)
                return null;
            logger_1.default.error({ err: err.message, giataId }, 'GIATA: failed to fetch images');
            throw err;
        }
    }
    // ─── MHG: Fact Sheet ────────────────────────────────────────────────
    /** Fetch structured fact sheet for a hotel. */
    async getFactSheet(giataId) {
        try {
            const response = await limiter.schedule(() => this.mhgClient.get(`/factsheets/${giataId}`));
            const parsed = xmlParser.parse(response.data);
            const item = parsed?.result?.item;
            if (!item)
                return null;
            const factsheet = item.factsheet;
            if (!factsheet)
                return null;
            const sections = toArray(factsheet.sections?.section);
            const facts = [];
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
                        values: valueList.map((v) => ({
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
        }
        catch (err) {
            if (err.response?.status === 404 || err.response?.status === 403)
                return null;
            logger_1.default.error({ err: err.message, giataId }, 'GIATA: failed to fetch fact sheet');
            throw err;
        }
    }
    // ─── MHG: Changed Items List ────────────────────────────────────────
    /** List GIATA IDs modified since a given date. */
    async getItemsChangedSince(since) {
        try {
            const response = await limiter.schedule(() => this.mhgClient.get(`/items/`, { params: { changedSince: since } }));
            const parsed = xmlParser.parse(response.data);
            const list = toArray(parsed?.result?.items?.item);
            return list.map((i) => ({
                giataId: String(i['@_giataId'] ?? ''),
                lastUpdate: i['@_lastUpdate'] ?? '',
            }));
        }
        catch (err) {
            logger_1.default.error({ err: err.message, since }, 'GIATA: failed to fetch changed items');
            return [];
        }
    }
    // ─── Multicodes: Property Details ───────────────────────────────────
    /** Fetch full property details from Multicodes (address, providers, geo, chains). */
    async getPropertyDetails(giataId) {
        try {
            const response = await limiter.schedule(() => this.multicodesClient.get(`/properties/${giataId}`));
            const parsed = xmlParser.parse(response.data);
            const property = parsed?.properties?.property;
            if (!property)
                return null;
            // Parse provider codes
            const providerList = toArray(property.propertyCodes?.provider);
            const providers = [];
            for (const p of providerList) {
                const codes = toArray(p.code);
                for (const c of codes) {
                    const values = toArray(c.value);
                    const codeValues = values.map((v) => typeof v === 'object' ? (v['#text'] ?? '') : String(v)).filter(Boolean);
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
            const defaultRating = ratings.find((r) => r['@_isDefault'] === 'true') ?? ratings[0];
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
        }
        catch (err) {
            // 301 = moved property
            if (err.response?.status === 301) {
                const errorXml = err.response?.data;
                if (errorXml) {
                    const parsed = xmlParser.parse(errorXml);
                    const newUrl = parsed?.error?.description?.['@_xlink:href'] ?? '';
                    const newGiataId = newUrl.split('/').pop();
                    if (newGiataId) {
                        logger_1.default.info({ oldGiataId: giataId, newGiataId }, 'GIATA: property moved (301)');
                        return this.getPropertyDetails(newGiataId);
                    }
                }
            }
            if (err.response?.status === 404)
                return null;
            logger_1.default.error({ err: err.message, giataId }, 'GIATA: failed to fetch property details');
            throw err;
        }
    }
    // ─── Multicodes: Moved Properties ───────────────────────────────────
    /** Get list of properties that have been moved/merged since a date. */
    async getMovedProperties(since) {
        try {
            const url = since
                ? `/properties/moved/since/${since}`
                : '/properties/moved/';
            const response = await limiter.schedule(() => this.multicodesClient.get(url));
            const parsed = xmlParser.parse(response.data);
            const list = toArray(parsed?.properties?.property);
            return list.map((p) => ({
                oldGiataId: String(p['@_giataId'] ?? ''),
                newGiataId: String(p['@_movedTo'] ?? ''),
                movedOn: p['@_movedOn'] ?? '',
            })).filter((m) => m.oldGiataId && m.newGiataId);
        }
        catch (err) {
            logger_1.default.error({ err: err.message, since }, 'GIATA: failed to fetch moved properties');
            return [];
        }
    }
    // ─── Multicodes: Resolve by Supplier Code ───────────────────────────
    /** Try to find a GIATA ID by looking up a supplier/GDS code in Multicodes. */
    async resolveByGds(providerCode, hotelCode) {
        try {
            const response = await limiter.schedule(() => this.multicodesClient.get(`/properties/gds/${providerCode}/${hotelCode}`));
            const parsed = xmlParser.parse(response.data);
            const properties = toArray(parsed?.properties?.property);
            if (properties.length === 0)
                return null;
            const id = properties[0]?.['@_giataId'];
            return id ? String(id) : null;
        }
        catch (err) {
            if (err.response?.status === 404)
                return null;
            logger_1.default.warn({ err: err.message, providerCode, hotelCode }, 'GIATA: resolve by GDS failed');
            return null;
        }
    }
    /**
     * Fetch a GIATA image binary using Basic Auth credentials.
     * Used by the backend proxy endpoint `GET /api/v1/hotels/giata-image`.
     *
     * Only accepts URLs on GIATA's official image hosts to prevent SSRF:
     *   - ghgml.giatamedia.com (sizes 74 / 320 / 800)
     *   - i.giatamedia.com     (sizes 1920 / 3840 — Full HD + 4K)
     * Returns null on auth / network / not-found failures.
     */
    async fetchImage(imageUrl) {
        if (!this.isConfigured())
            return null;
        // SSRF guard — allow only GIATA's official image hosts.
        const ALLOWED_HOSTS = new Set(['ghgml.giatamedia.com', 'i.giatamedia.com']);
        let host;
        try {
            host = new URL(imageUrl).hostname;
        }
        catch {
            return null;
        }
        if (!ALLOWED_HOSTS.has(host))
            return null;
        try {
            const response = await axios_1.default.get(imageUrl, {
                auth: {
                    username: config_1.default.giata.username,
                    password: config_1.default.giata.password,
                },
                responseType: 'arraybuffer',
                timeout: 15000,
            });
            return {
                data: Buffer.from(response.data),
                contentType: response.headers['content-type'] ?? 'image/jpeg',
            };
        }
        catch (err) {
            if (err?.response?.status === 404)
                return null;
            logger_1.default.warn({ err: err.message, imageUrl }, 'GIATA: fetchImage failed');
            return null;
        }
    }
}
exports.default = new GiataClientService();
