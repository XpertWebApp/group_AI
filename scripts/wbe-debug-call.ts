/**
 * Quick debug call to WBE UAT — replicate the probe worker's exact shape
 * with a known-good hotel code to verify the connection works at all.
 */
import 'dotenv/config';
import wbeClientService from '../src/services/wbe.client.service';

async function main() {
    const hotelCode = '0Ap4RHjyXZw='; // recently returned COMPLETED via probe worker
    const body = {
        HotelIds: [hotelCode],
        CheckInDate: '2026-08-15',
        Nights: 3,
        WaitSeconds: 45,
        CurrencyCode: 'EUR',
        NationalityCode: 'HU',
        // 3 rooms × 2 adults each (the probe-worker convention)
        Rooms: [
            { RoomID: 1, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
            { RoomID: 2, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
            { RoomID: 3, AdultsNo: '2', ChildrenNo: '0', ChildrenAges: [] },
        ],
    };

    console.log('Request:', JSON.stringify(body, null, 2));
    console.log('\nCalling SearchAndGetByHotelsV2...');
    const t = Date.now();
    const res = await wbeClientService.searchAndGetByHotelsV2(body);
    console.log(`Response (${Date.now() - t}ms):`);
    console.log(JSON.stringify(res, null, 2).slice(0, 3000));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
