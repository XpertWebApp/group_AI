/**
 * Turn whatever WBE sends as a hotel's country into something that fits
 * master.hotels.address_country (varchar 10), preferring an ISO code.
 *
 * WBE's HotelDetails `AddressCountry` is not consistently an ISO code: for
 * some hotels it is a full country name ("United Kingdom"), which overflows
 * the column and makes the whole hotel update fail. Order of preference:
 *
 *   1. A 2- or 3-letter value is already a code: uppercase and keep it.
 *   2. The ISO code of the hotel's destination (master.destinations.country_code).
 *   3. The country name looked up against a name → ISO-2 table.
 *   4. null.
 *
 * Whatever comes out is never longer than the column allows.
 */

const MAX_LENGTH = 10;

/** Lowercase, strip accents and punctuation, collapse spaces. */
function normaliseName(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\bst\b/g, 'saint')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^the /, '');
}

/**
 * Codes Intl still names but that are not current countries (East Germany,
 * Yugoslavia, USSR...) or are groupings (EU, UN). Skipped so that, for
 * example, "Deutschland" resolves to DE and not DD.
 */
const SKIP_CODES = new Set([
    'AA', 'AN', 'BU', 'CS', 'CT', 'DD', 'DY', 'EU', 'EZ', 'FQ', 'FX', 'HV', 'JT', 'MI', 'NH', 'NQ', 'NT', 'PC', 'PU', 'PZ',
    'QO', 'QU', 'RH', 'SU', 'TP', 'UN', 'VD', 'WK', 'XA', 'XB', 'YD', 'YU', 'ZR', 'ZZ',
]);

/** Names that Intl does not produce but suppliers commonly send. */
const ALIASES: Record<string, string> = {
    usa: 'US',
    'united states of america': 'US',
    america: 'US',
    uk: 'GB',
    'great britain': 'GB',
    britain: 'GB',
    england: 'GB',
    scotland: 'GB',
    wales: 'GB',
    'northern ireland': 'GB',
    uae: 'AE',
    turkey: 'TR',
    holland: 'NL',
    'czech republic': 'CZ',
    'russian federation': 'RU',
    'republic of korea': 'KR',
    korea: 'KR',
    'viet nam': 'VN',
    macedonia: 'MK',
    'north macedonia': 'MK',
    swaziland: 'SZ',
    'ivory coast': 'CI',
    'cote d ivoire': 'CI',
    burma: 'MM',
    'cape verde': 'CV',
    vatican: 'VA',
    'vatican city': 'VA',
    'hong kong': 'HK',
    'hong kong sar': 'HK',
    macau: 'MO',
    macao: 'MO',
    'macau sar': 'MO',
    'palestinian territories': 'PS',
};

let nameToIso: Map<string, string> | null = null;

/**
 * Built once from the runtime's own region names (Intl.DisplayNames), in the
 * languages WBE data is likely to use, so no country list has to be kept by hand.
 */
function getNameToIso(): Map<string, string> {
    if (nameToIso) return nameToIso;

    const map = new Map<string, string>();
    const languages = ['en', 'de', 'fr', 'es', 'it'];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    for (const lang of languages) {
        let names: Intl.DisplayNames;
        try {
            names = new Intl.DisplayNames([lang], { type: 'region' });
        } catch {
            continue;
        }
        for (const a of letters) {
            for (const b of letters) {
                const code = a + b;
                if (SKIP_CODES.has(code)) continue;
                let name: string | undefined;
                try {
                    name = names.of(code);
                } catch {
                    continue;
                }
                // Unknown codes come back as the code itself or "Unknown Region".
                if (!name || name === code || /unknown/i.test(name)) continue;
                const key = normaliseName(name);
                if (key && !map.has(key)) map.set(key, code);
            }
        }
    }

    for (const [name, code] of Object.entries(ALIASES)) {
        map.set(name, code);
    }

    nameToIso = map;
    return map;
}

/** Look a country name up; null when it is not recognised. */
export function countryNameToIso(name: string): string | null {
    const key = normaliseName(name);
    if (!key) return null;
    return getNameToIso().get(key) ?? null;
}

/**
 * The value to store in address_country.
 *
 * @param raw                What WBE sent (AddressCountry).
 * @param destinationCountry The ISO code of the hotel's destination, if known.
 */
export function normaliseCountryCode(
    raw: unknown,
    destinationCountry?: string | null,
): string | null {
    const value = typeof raw === 'string' ? raw.trim() : '';

    // 1. Already a code.
    if (/^[A-Za-z]{2,3}$/.test(value)) {
        return value.toUpperCase();
    }

    // 2. The destination's code.
    const dest = typeof destinationCountry === 'string' ? destinationCountry.trim() : '';
    if (dest) {
        return dest.toUpperCase().slice(0, MAX_LENGTH);
    }

    // 3. Name lookup.
    if (value) {
        const iso = countryNameToIso(value);
        if (iso) return iso;
    }

    // 4. Nothing usable.
    return null;
}
