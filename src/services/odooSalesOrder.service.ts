import odooClient from './odoo.client.service';
import * as cfg from '../config/odooSalesOrder';
import logger from '../utils/logger';

/**
 * Writes the commercial record of a group booking into Odoo.
 *
 * The client's process treats Odoo as the commercial system and SETT Hub as the
 * operational one: the sales order is what the customer is invoiced against,
 * while the reservations behind it live with the supplier. The two are linked
 * by reference, and neither is authoritative for the other.
 *
 * Two things here are not incidental.
 *
 * The order is raised under the Canadian company. Group bookings run through
 * LTD, which sells to the customer, while FZE supplies the booking to LTD as an
 * internal transaction. Raising it under the wrong company produces a valid
 * order in the wrong ledger — no error, just a reconciliation problem weeks
 * later.
 *
 * Failure here does not fail the booking. By the time this runs the customer has
 * chosen and rooms may already be held; refusing the booking because an
 * accounting record could not be written would be the wrong way round. Failures
 * are reported so an operator can complete the order by hand.
 */

export class OdooSalesOrderError extends Error {
    constructor(
        message: string,
        readonly code: 'DISABLED' | 'NO_CUSTOMER' | 'WRITE_FAILED',
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'OdooSalesOrderError';
    }
}

/** Everything the sales order needs, gathered from the request and selection. */
export interface SalesOrderInput {
    /** Odoo partner the offer was sent to. Without it there is no order. */
    customerPartnerId: number;

    /** SETT Hub references, so the two systems can be reconciled. */
    requestReference?: number | string;
    groupReference?: string;

    groupName?: string;
    groupSize?: number;
    groupType?: string;

    destinationName?: string;
    hotelName?: string;
    hotelAddress?: string;
    hotelCategory?: string;

    checkInDate: Date;
    checkOutDate: Date;
    nights: number;

    /** Rooms by type, as quoted. */
    roomBreakdown?: Record<string, number>;
    roomsTotal: number;
    mealPlan?: string;

    /** What SETT pays the supplier, across the whole booking. */
    buyingTotal?: number;
    /** What the customer pays. */
    sellingTotal: number;
    currency?: string;

    cancellationConditions?: string;
    paymentConditions?: string;
    nonRefundable: boolean;

    /** Supplier reservation references, one per split booking. */
    reservationNumbers?: string[];
}

export interface SalesOrderResult {
    orderId: number;
    orderName: string;
    /** Reservation rows written against the order. */
    reservationIds: number[];
}

export class OdooSalesOrderService {
    /**
     * Create the sales order for a group booking.
     *
     * Written under LTD with the customer as partner. The hotel and supplier
     * appear in the line descriptions as well as the order fields, because the
     * client reads the lines when checking an order rather than opening each
     * field.
     */
    async createGroupSalesOrder(input: SalesOrderInput): Promise<SalesOrderResult> {
        if (!cfg.ODOO_SALES_ORDER_ENABLED) {
            throw new OdooSalesOrderError(
                'Odoo sales order creation is disabled in this environment',
                'DISABLED',
            );
        }
        if (!input.customerPartnerId) {
            throw new OdooSalesOrderError(
                'This request is not linked to an Odoo customer, so no sales order can be raised',
                'NO_CUSTOMER',
            );
        }

        const stageId = await this.resolveStageId(cfg.INITIAL_STAGE_NAME);

        const orderId = await odooClient.call<number>('sale.order', 'create', [
            {
                company_id: cfg.SELLER_COMPANY_ID,
                partner_id: input.customerPartnerId,
                // Odoo defaults these to the customer when omitted, but stating
                // them keeps the order valid if that default ever changes.
                partner_invoice_id: input.customerPartnerId,
                partner_shipping_id: input.customerPartnerId,
                date_order: this.odooDateTime(new Date()),
                ...(stageId ? { x_stage_id: stageId } : {}),

                // ── Group detail ────────────────────────────────────────────
                ...(input.groupName ? { x_studio_group_name: input.groupName } : {}),
                ...(input.groupSize ? { x_studio_pax: input.groupSize } : {}),
                ...(input.groupType ? { x_studio_group_type: input.groupType } : {}),
                ...(input.destinationName ? { x_studio_destination: input.destinationName } : {}),
                ...(input.hotelCategory ? { x_studio_hotel_category: input.hotelCategory } : {}),
                x_studio_arrival_date: this.odooDate(input.checkInDate),
                x_studio_departure_date: this.odooDate(input.checkOutDate),

                // The conditions the customer accepted, in the order's own
                // note so they travel with the commercial record rather than
                // living only in SETT Hub.
                x_internal_group_note: this.buildInternalNote(input),

                order_line: [[0, 0, this.buildAccommodationLine(input)]],
            },
        ]);

        const order = await odooClient.call<Array<{ name: string }>>('sale.order', 'read', [
            [orderId],
            ['name'],
        ]);

        const reservationIds = await this.attachReservations(orderId, input);

        logger.info({
            msg: 'Odoo sales order created',
            orderId,
            orderName: order[0]?.name,
            company: cfg.SELLER_COMPANY_ID,
            groupReference: input.groupReference,
            reservations: reservationIds.length,
        });

        return {
            orderId,
            orderName: order[0]?.name ?? String(orderId),
            reservationIds,
        };
    }

    /**
     * Move an order to a different stage in Odoo's pipeline.
     *
     * The stages mirror the client's own process — New Inquiry, Offer Sent,
     * Optioned, Confirmed — so keeping the order in step means anyone watching
     * the pipeline sees where a group actually is without opening SETT Hub.
     *
     * Returns the stage name on success and null when it could not be set. A
     * stage is presentational: failing to move one is not a reason to fail a
     * booking that has already reserved rooms.
     */
    async moveToStage(orderId: number, stageName: string): Promise<string | null> {
        try {
            const stageId = await this.resolveStageId(stageName);
            if (!stageId) return null;

            await odooClient.call('sale.order', 'write', [[orderId], { x_stage_id: stageId }]);

            logger.info({ msg: 'Odoo order stage updated', orderId, stage: stageName });
            return stageName;
        } catch (err: any) {
            logger.warn({
                msg: 'Could not move Odoo order to stage',
                orderId,
                stage: stageName,
                error: err.message,
            });
            return null;
        }
    }

    /**
     * Attach the supplier reservation references to an existing order.
     *
     * Separate from creation because the references arrive later: the order is
     * raised when the customer selects, and the reservations exist only once
     * the bookings have been made.
     */
    async attachReservations(orderId: number, input: {
        reservationNumbers?: string[];
        hotelName?: string;
        buyingTotal?: number;
    }): Promise<number[]> {
        const numbers = input.reservationNumbers ?? [];
        if (numbers.length === 0) return [];

        const ids: number[] = [];
        for (const number of numbers) {
            try {
                const id = await odooClient.call<number>(cfg.RESERVATION_MODEL, 'create', [
                    {
                        x_sale_order_id: orderId,
                        // The existing rows in Odoo carry the hotel alongside
                        // the reference, so a reader can tell what a booking is
                        // without opening it.
                        x_name: input.hotelName
                            ? `${input.hotelName} - ${number}`
                            : number,
                        x_reservation_number: number,
                        x_sync_status: 'synced',
                        x_last_sync: this.odooDateTime(new Date()),
                    },
                ]);
                ids.push(id);
            } catch (err: any) {
                // One reference failing must not cost the others: each is an
                // independent link back to a reservation that exists at the
                // supplier whether or not Odoo records it.
                logger.error({
                    msg: 'Could not write reservation reference to Odoo',
                    orderId,
                    reservationNumber: number,
                    error: err.message,
                });
            }
        }
        return ids;
    }

    /**
     * The accommodation line.
     *
     * The cost is written into the description rather than into
     * `purchase_price`. That field is writable but Odoo recomputes it from the
     * line's product, and these lines carry no product — verified against the
     * live instance, where both a create and a follow-up write came back as
     * zero. Odoo therefore reports the whole sale as margin.
     *
     * Stating the buying total in text is honest about that: an operator
     * reviewing the order sees the real cost, rather than a margin figure that
     * looks authoritative and is wrong. Making Odoo compute it properly needs a
     * product set up on their side, which is a decision for the client.
     */
    private buildAccommodationLine(input: SalesOrderInput) {
        return {
            name: this.buildLineDescription(input),
            product_uom_qty: 1,
            price_unit: input.sellingTotal,
        };
    }

    /**
     * Line description carrying the hotel and supplier.
     *
     * Explicitly asked for: "the selected hotel and supplier information must
     * also be included in the sales-order-line descriptions".
     */
    private buildLineDescription(input: SalesOrderInput): string {
        const parts = [
            input.hotelName ?? 'Group accommodation',
            input.destinationName ? `${input.destinationName}` : null,
            `${this.formatDate(input.checkInDate)} – ${this.formatDate(input.checkOutDate)} (${input.nights} nights)`,
            `${input.roomsTotal} room(s)${input.roomBreakdown ? ` — ${this.formatRooms(input.roomBreakdown)}` : ''}`,
            input.mealPlan ? `Meal plan: ${input.mealPlan}` : null,
            'Supplier: S-E-T-T Worldwide Reservation FZE',
            // Odoo's own margin cannot be trusted on these lines (no product,
            // so purchase_price recomputes to zero), which is why the buying
            // total is stated here.
            input.buyingTotal !== undefined
                ? `Buying total: ${input.buyingTotal} ${input.currency ?? ''} · ` +
                  `Selling total: ${input.sellingTotal} ${input.currency ?? ''}`
                : null,
            input.nonRefundable ? 'NON-REFUNDABLE' : 'Refundable',
        ];
        return parts.filter(Boolean).join('\n');
    }

    /** The accepted conditions, for the order's internal note. */
    private buildInternalNote(input: SalesOrderInput): string {
        const lines = [
            input.groupReference ? `SETT Hub group reference: ${input.groupReference}` : null,
            input.requestReference ? `Request: #${input.requestReference}` : null,
            '',
            input.cancellationConditions
                ? `Cancellation: ${input.cancellationConditions}`
                : null,
            input.paymentConditions ? `Payment: ${input.paymentConditions}` : null,
            input.nonRefundable
                ? 'Rate is NON-REFUNDABLE — the customer accepted these conditions explicitly.'
                : 'Rate is refundable.',
            input.buyingTotal !== undefined
                ? `Buying total: ${input.buyingTotal} ${input.currency ?? ''}`
                : null,
            `Selling total: ${input.sellingTotal} ${input.currency ?? ''}`,
        ];
        return lines.filter((l) => l !== null).join('<br/>');
    }

    /**
     * Resolve a stage name to its id.
     *
     * By name rather than by a hardcoded id: the ids are database-specific, and
     * an order landing in the wrong pipeline stage is invisible to whoever
     * watches that pipeline. A stage that cannot be found is left unset rather
     * than guessed.
     */
    private async resolveStageId(name: string): Promise<number | null> {
        try {
            const rows = await odooClient.call<Array<{ id: number }>>(
                'x_sett_group_stage',
                'search_read',
                [[['x_name', '=', name]], ['id']],
                { limit: 1 },
            );
            return rows[0]?.id ?? null;
        } catch (err: any) {
            logger.warn({
                msg: 'Could not resolve Odoo pipeline stage; order will use the default',
                stage: name,
                error: err.message,
            });
            return null;
        }
    }

    private formatRooms(breakdown: Record<string, number>): string {
        return Object.entries(breakdown)
            .filter(([, count]) => count > 0)
            .map(([type, count]) => `${count} ${type}`)
            .join(', ');
    }

    private formatDate(d: Date): string {
        return d.toISOString().slice(0, 10);
    }

    /** Odoo expects naive UTC strings, not ISO with a zone. */
    private odooDate(d: Date): string {
        return d.toISOString().slice(0, 10);
    }

    private odooDateTime(d: Date): string {
        return d.toISOString().slice(0, 19).replace('T', ' ');
    }
}

export default new OdooSalesOrderService();
