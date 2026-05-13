/**
 * Single-hotel test matrix: pin to one hotel code that we know UAT recognizes,
 * vary the rooms array + nights to see which scenarios UAT has inventory for.
 */
import 'dotenv/config';
import wbeClientService from '../src/services/wbe.client.service';

const HOTEL = '0Ap4RHjyXZw=';
const DATE = '2026-08-15';

async function tryCombo(label: string, nights: number, rooms: any[]) {
    const body = {
        HotelIds: [HOTEL],
        CheckInDate: DATE,
        Nights: nights,
        WaitSeconds: 45,
        CurrencyCode: 'EUR',
        NationalityCode: 'HU',
        Rooms: rooms,
    };
    const t = Date.now();
    const res = await wbeClientService.searchAndGetByHotelsV2(body);
    const h = (res?.Data?.Hotels ?? []).length;
    const o = (res?.Data?.Hotels ?? []).reduce((s: number, x: any) => s + (x?.Options?.length ?? 0), 0);
    console.log(`${label}: ${Date.now() - t}ms, Hotels=${h}, Options=${o}`);
    return o;
}

async function main() {
    console.log(`Hotel: ${HOTEL}, CheckIn: ${DATE}\n`);

    // Baseline (known to work)
    await tryCombo('3 rooms × 2 adults, 3 nights (baseline)', 3, [
        { RoomID: 1, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
        { RoomID: 2, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
        { RoomID: 3, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
    ]);

    // Vary just nights
    await tryCombo('3 rooms × 2 adults, 4 nights', 4, [
        { RoomID: 1, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
        { RoomID: 2, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
        { RoomID: 3, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
    ]);

    // Scenario shapes (one hotel)
    await tryCombo('SC3: 1 room × 1 adult, 4 nights', 4, [
        { RoomID: 1, AdultsNo: '1', ChildrenNo: '0', ChildrenAges: [] },
    ]);
    await tryCombo('SC6: 1 room × 3 adults, 10 nights', 10, [
        { RoomID: 1, AdultsNo: '3', ChildrenNo: '0', ChildrenAges: [] },
    ]);
    await tryCombo('SC7: 2 rooms × 2 adults, 2 nights', 2, [
        { RoomID: 1, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
        { RoomID: 2, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
    ]);
    await tryCombo('SC10: 2 rooms (3+4 adults), 4 nights', 4, [
        { RoomID: 1, AdultsNo: '3', ChildrenNo: '0', ChildrenAges: [] },
        { RoomID: 2, AdultsNo: '4', ChildrenNo: '0', ChildrenAges: [] },
    ]);
}

main().catch((e) => { console.error(e); process.exit(1); });
