/**
 * Unit tests for the Odoo sales order write.
 *
 * The order is the commercial record a customer is invoiced against, so the
 * failures worth guarding are the quiet ones: an order raised under the wrong
 * company lands in the wrong ledger without any error, and surfaces weeks later
 * in the accounts.
 *
 * Odoo is mocked. What is under test is the payload we send it — the company,
 * the customer, and what the line descriptions say — not Odoo's own behaviour.
 */
jest.mock('../services/odoo.client.service', () => ({
    __esModule: true,
    default: { call: jest.fn() },
}));

import odooClient from '../services/odoo.client.service';
import service, { OdooSalesOrderError } from '../services/odooSalesOrder.service';
import * as cfg from '../config/odooSalesOrder';

const odoo = odooClient as jest.Mocked<any>;

// ── Fixtures ────────────────────────────────────────────────────────────────

const CUSTOMER_PARTNER_ID = 43121;

const input = (over: Record<string, unknown> = {}) => ({
    customerPartnerId: CUSTOMER_PARTNER_ID,
    requestReference: 542,
    groupReference: 'SETTG-ABC123',
    groupName: 'Test Travel GmbH',
    groupSize: 30,
    groupType: 'Corporate',
    destinationName: 'Rome',
    hotelName: 'Hotel Roma',
    hotelCategory: '4*',
    checkInDate: new Date('2026-10-01'),
    checkOutDate: new Date('2026-10-04'),
    nights: 3,
    roomBreakdown: { single: 5, double: 10 },
    roomsTotal: 15,
    mealPlan: 'Room Only',
    buyingTotal: 12000,
    sellingTotal: 14400,
    currency: 'EUR',
    cancellationConditions: 'Free cancellation until 2026-09-15',
    paymentConditions: 'Payment due by 2026-09-20',
    nonRefundable: false,
    ...over,
});

/** The payload passed to sale.order create. */
const orderPayload = () => odoo.call.mock.calls.find((c: any[]) => c[1] === 'create')![2][0];

/** The single accommodation line inside that payload. */
const orderLine = () => orderPayload().order_line[0][2];

beforeEach(() => {
    jest.clearAllMocks();

    odoo.call.mockImplementation(async (model: string, method: string) => {
        if (model === 'x_sett_group_stage' && method === 'search_read') return [{ id: 1 }];
        if (model === 'sale.order' && method === 'create') return 308;
        if (model === 'sale.order' && method === 'read') return [{ name: 'S00329' }];
        if (model === cfg.RESERVATION_MODEL && method === 'create') return 12;
        return null;
    });
});

describe('Odoo sales order', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('which company the order belongs to', () => {
        it('raises the order under the selling company', async () => {
            // "Group bookings under this process always run through the
            // Canadian company." Wrong company is a valid order in the wrong
            // ledger — no error, just a reconciliation problem later.
            await service.createGroupSalesOrder(input() as any);
            expect(orderPayload().company_id).toBe(cfg.SELLER_COMPANY_ID);
        });

        it('puts the customer on the order, not either SETT company', async () => {
            await service.createGroupSalesOrder(input() as any);
            expect(orderPayload().partner_id).toBe(CUSTOMER_PARTNER_ID);
        });

        it('states the invoice and delivery addresses rather than relying on a default', async () => {
            await service.createGroupSalesOrder(input() as any);
            expect(orderPayload().partner_invoice_id).toBe(CUSTOMER_PARTNER_ID);
            expect(orderPayload().partner_shipping_id).toBe(CUSTOMER_PARTNER_ID);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('what the order carries', () => {
        it('records the group name, size and type', async () => {
            await service.createGroupSalesOrder(input() as any);
            const p = orderPayload();
            expect(p.x_studio_group_name).toBe('Test Travel GmbH');
            expect(p.x_studio_pax).toBe(30);
            expect(p.x_studio_group_type).toBe('Corporate');
        });

        it('records the travel dates in the format Odoo stores', async () => {
            await service.createGroupSalesOrder(input() as any);
            expect(orderPayload().x_studio_arrival_date).toBe('2026-10-01');
            expect(orderPayload().x_studio_departure_date).toBe('2026-10-04');
        });

        it('carries the SETT references so the two systems can be reconciled', async () => {
            await service.createGroupSalesOrder(input() as any);
            expect(orderPayload().x_internal_group_note).toContain('SETTG-ABC123');
            expect(orderPayload().x_internal_group_note).toContain('542');
        });

        it('records the conditions the customer accepted', async () => {
            await service.createGroupSalesOrder(input() as any);
            const note = orderPayload().x_internal_group_note;
            expect(note).toContain('Free cancellation until 2026-09-15');
            expect(note).toContain('Payment due by 2026-09-20');
        });

        it('says plainly when a rate is non-refundable', async () => {
            await service.createGroupSalesOrder(input({ nonRefundable: true }) as any);
            expect(orderPayload().x_internal_group_note).toMatch(/NON-REFUNDABLE/);
        });

        it('omits a field the caller did not supply rather than sending an empty one', async () => {
            await service.createGroupSalesOrder(input({ groupName: undefined }) as any);
            expect(orderPayload()).not.toHaveProperty('x_studio_group_name');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the order line', () => {
        it('names the hotel and the supplier, as the client asked', async () => {
            // "The selected hotel and supplier information must also be
            // included in the sales-order-line descriptions."
            await service.createGroupSalesOrder(input() as any);
            expect(orderLine().name).toContain('Hotel Roma');
            expect(orderLine().name).toContain('S-E-T-T Worldwide Reservation FZE');
        });

        it('states the rooms and the stay', async () => {
            await service.createGroupSalesOrder(input() as any);
            expect(orderLine().name).toContain('15 room(s)');
            expect(orderLine().name).toContain('3 nights');
        });

        it('breaks the rooms down by type', async () => {
            await service.createGroupSalesOrder(input() as any);
            expect(orderLine().name).toContain('5 single');
            expect(orderLine().name).toContain('10 double');
        });

        it('states both the buying and the selling total', async () => {
            // Odoo cannot compute the margin on these lines — purchase_price
            // recomputes from a product, and there is none — so the real cost
            // is written where a reviewer will actually read it.
            await service.createGroupSalesOrder(input() as any);
            expect(orderLine().name).toContain('12000');
            expect(orderLine().name).toContain('14400');
        });

        it('charges the customer the selling total', async () => {
            await service.createGroupSalesOrder(input() as any);
            expect(orderLine().price_unit).toBe(14400);
        });

        it('does not send purchase_price, which Odoo would overwrite anyway', async () => {
            // Verified against the live instance: both a create and a
            // follow-up write came back as zero.
            await service.createGroupSalesOrder(input() as any);
            expect(orderLine()).not.toHaveProperty('purchase_price');
        });

        it('marks a refundable rate as such', async () => {
            await service.createGroupSalesOrder(input() as any);
            expect(orderLine().name).toContain('Refundable');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the pipeline stage', () => {
        it('resolves the stage by name rather than a hardcoded id', async () => {
            // Stage ids are database-specific; an order in the wrong stage is
            // invisible to whoever watches that pipeline.
            await service.createGroupSalesOrder(input() as any);

            expect(odoo.call).toHaveBeenCalledWith(
                'x_sett_group_stage',
                'search_read',
                expect.anything(),
                expect.anything(),
            );
            expect(orderPayload().x_stage_id).toBe(1);
        });

        it('creates the order anyway when the stage cannot be resolved', async () => {
            // A missing stage is not a reason to lose the commercial record.
            odoo.call.mockImplementation(async (model: string, method: string) => {
                if (model === 'x_sett_group_stage') throw new Error('stage model missing');
                if (model === 'sale.order' && method === 'create') return 308;
                if (model === 'sale.order' && method === 'read') return [{ name: 'S00329' }];
                return null;
            });

            const res = await service.createGroupSalesOrder(input() as any);
            expect(res.orderId).toBe(308);
            expect(orderPayload()).not.toHaveProperty('x_stage_id');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('moving an order through the pipeline', () => {
        it('writes the resolved stage id onto the order', async () => {
            const result = await service.moveToStage(308, 'Optioned');

            expect(result).toBe('Optioned');
            expect(odoo.call).toHaveBeenCalledWith(
                'sale.order',
                'write',
                [[308], { x_stage_id: 1 }],
            );
        });

        it('reports null for a stage that does not exist', async () => {
            // Stage names differ between Odoo databases. Guessing an id would
            // move the order somewhere nobody is watching.
            odoo.call.mockImplementation(async (model: string) => {
                if (model === 'x_sett_group_stage') return [];
                return null;
            });

            expect(await service.moveToStage(308, 'Nonexistent')).toBeNull();
        });

        it('does not write when the stage cannot be resolved', async () => {
            odoo.call.mockImplementation(async (model: string) => {
                if (model === 'x_sett_group_stage') return [];
                return null;
            });

            await service.moveToStage(308, 'Nonexistent');

            expect(odoo.call).not.toHaveBeenCalledWith(
                'sale.order',
                'write',
                expect.anything(),
            );
        });

        it('swallows an Odoo failure rather than failing the booking', async () => {
            // A stage is presentational. Rooms are already held by the time
            // this runs, and losing them over a pipeline column would be absurd.
            odoo.call.mockImplementation(async (model: string, method: string) => {
                if (model === 'x_sett_group_stage') return [{ id: 1 }];
                if (method === 'write') throw new Error('Odoo unreachable');
                return null;
            });

            await expect(service.moveToStage(308, 'Optioned')).resolves.toBeNull();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('reservation references', () => {
        it('writes one row per supplier reservation', async () => {
            const res = await service.createGroupSalesOrder(
                input({ reservationNumbers: ['WRW111', 'WRW222'] }) as any,
            );
            expect(res.reservationIds).toHaveLength(2);
        });

        it('links each row to the order', async () => {
            await service.createGroupSalesOrder(input({ reservationNumbers: ['WRW111'] }) as any);

            const row = odoo.call.mock.calls.find(
                (c: any[]) => c[0] === cfg.RESERVATION_MODEL,
            )![2][0];
            expect(row.x_sale_order_id).toBe(308);
            expect(row.x_reservation_number).toBe('WRW111');
        });

        it('names the row with the hotel, matching what Odoo already holds', async () => {
            await service.createGroupSalesOrder(input({ reservationNumbers: ['WRW111'] }) as any);

            const row = odoo.call.mock.calls.find(
                (c: any[]) => c[0] === cfg.RESERVATION_MODEL,
            )![2][0];
            expect(row.x_name).toBe('Hotel Roma - WRW111');
        });

        it('keeps the other references when one fails to write', async () => {
            // Each reference is an independent link to a reservation that
            // exists at the supplier whether or not Odoo records it.
            let attempt = 0;
            odoo.call.mockImplementation(async (model: string, method: string) => {
                if (model === 'x_sett_group_stage') return [{ id: 1 }];
                if (model === 'sale.order' && method === 'create') return 308;
                if (model === 'sale.order' && method === 'read') return [{ name: 'S00329' }];
                if (model === cfg.RESERVATION_MODEL) {
                    attempt++;
                    if (attempt === 1) throw new Error('write rejected');
                    return 13;
                }
                return null;
            });

            const res = await service.createGroupSalesOrder(
                input({ reservationNumbers: ['WRW111', 'WRW222'] }) as any,
            );
            expect(res.reservationIds).toHaveLength(1);
        });

        it('writes nothing when there are no references yet', async () => {
            // The order is raised when the customer selects; the reservations
            // exist only once the bookings have been made.
            const res = await service.createGroupSalesOrder(input() as any);
            expect(res.reservationIds).toHaveLength(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('refusals', () => {
        it('refuses a request with no Odoo customer', async () => {
            await expect(
                service.createGroupSalesOrder(input({ customerPartnerId: 0 }) as any),
            ).rejects.toMatchObject({ code: 'NO_CUSTOMER' });
        });

        it('creates nothing when it refuses', async () => {
            await service
                .createGroupSalesOrder(input({ customerPartnerId: 0 }) as any)
                .catch(() => undefined);
            expect(odoo.call).not.toHaveBeenCalled();
        });

        it('reports the error type so a caller can react', async () => {
            await expect(
                service.createGroupSalesOrder(input({ customerPartnerId: 0 }) as any),
            ).rejects.toBeInstanceOf(OdooSalesOrderError);
        });
    });
});
