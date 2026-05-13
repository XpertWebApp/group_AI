/**
 * Try scenario 7 (2 rooms × 2 adults — closest to UAT's "happy path" of 3 × 2)
 * across a few different dates to rule out date-range as the cause.
 */
import 'dotenv/config';
import wbeClientService from '../src/services/wbe.client.service';

async function tryDate(checkIn: string, nights: number, label: string) {
    const body = {
        HotelIds: ['0Ap4RHjyXZw=', '0cr/o3acC6o=', '03aBCNS2yXU=', '0CTw05ceqzg=', '01H5FZ3UFrk='],
        CheckInDate: checkIn,
        Nights: nights,
        WaitSeconds: 45,
        CurrencyCode: 'EUR',
        NationalityCode: 'HU',
        Rooms: [
            { RoomID: 1, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
            { RoomID: 2, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
        ],
    };
    const t = Date.now();
    const res = await wbeClientService.searchAndGetByHotelsV2(body);
    const elapsed = Date.now() - t;
    const hotelsCount = (res?.Data?.Hotels ?? []).length;
    const optionsCount = (res?.Data?.Hotels ?? []).reduce((s: number, h: any) => s + (h?.Options?.length ?? 0), 0);
    console.log(`${label}: ${elapsed}ms, Hotels=${hotelsCount}, Options=${optionsCount}, Finished=${res?.Finished}`);
}

async function main() {
    // Same shape (2 rooms × 2 adults), varying dates
    console.log('Test 2 rooms × 2 adults at varying dates:');
    await tryDate('2026-06-15', 2, 'June 15 / 2 nights');
    await tryDate('2026-07-15', 2, 'July 15 / 2 nights');
    await tryDate('2026-08-15', 2, 'Aug 15 / 2 nights');
    await tryDate('2026-12-15', 2, 'Dec 15 / 2 nights');
    await tryDate('2027-03-15', 2, 'Mar 15 2027 / 2 nights');

    // And same shape but 3 rooms × 2 adults at the same dates to confirm UAT
    console.log('\nTest 3 rooms × 2 adults (UAT happy path) for comparison:');
    const body3 = {
        HotelIds: ['0Ap4RHjyXZw=', '0cr/o3acC6o=', '03aBCNS2yXU=', '0CTw05ceqzg=', '01H5FZ3UFrk='],
        CheckInDate: '2026-08-15',
        Nights: 2,
        WaitSeconds: 45,
        CurrencyCode: 'EUR',
        NationalityCode: 'HU',
        Rooms: [
            { RoomID: 1, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
            { RoomID: 2, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
            { RoomID: 3, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
        ],
    };
    const t = Date.now();
    const r3 = await wbeClientService.searchAndGetByHotelsV2(body3);
    const h3 = (r3?.Data?.Hotels ?? []).length;
    const o3 = (r3?.Data?.Hotels ?? []).reduce((s: number, h: any) => s + (h?.Options?.length ?? 0), 0);
    console.log(`3 rooms × 2 adults / Aug 15 / 2 nights: ${Date.now() - t}ms, Hotels=${h3}, Options=${o3}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
