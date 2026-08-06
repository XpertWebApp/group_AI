/**
 * Odoo identifiers for the group booking sales order.
 *
 * The client's process routes group bookings through two of the three
 * companies in the Odoo database, and puts the customer sale on the Canadian
 * one. Getting this wrong does not fail loudly — it produces a valid order in
 * the wrong ledger, which surfaces weeks later in the accounts.
 *
 * All values below were read from the live Odoo instance rather than assumed.
 */

/**
 * The company that sells to the customer.
 *
 * "Group bookings under this process always run through the Canadian company"
 * — and the existing orders bear that out: 147 sales orders sit under LTD
 * against 20 under FZE.
 */
export const SELLER_COMPANY_ID = Number(process.env['ODOO_SELLER_COMPANY_ID'] ?? 2);

/**
 * The company that supplies the booking to LTD.
 *
 * FZE holds the supplier relationships and makes the reservation; LTD buys it
 * from FZE and sells it on. The two legs are separate transactions and the
 * customer invoice must not be mixed into FZE's own invoicing cycle.
 */
export const SUPPLIER_COMPANY_ID = Number(process.env['ODOO_SUPPLIER_COMPANY_ID'] ?? 1);

/** Partner records for the two companies, used on the intercompany lines. */
export const SELLER_PARTNER_ID = Number(process.env['ODOO_SELLER_PARTNER_ID'] ?? 43750);
export const SUPPLIER_PARTNER_ID = Number(process.env['ODOO_SUPPLIER_PARTNER_ID'] ?? 1);

/**
 * Pipeline stage a new group order starts in.
 *
 * Matches where staff-created orders begin, so a generated order appears in the
 * same place in the pipeline as one entered by hand rather than in a stage
 * nobody watches.
 */
export const INITIAL_STAGE_NAME = process.env['ODOO_INITIAL_STAGE'] ?? 'New Inquiry';

/**
 * Stage an order moves to once rooms are actually held.
 *
 * "Optioned" in the client's own pipeline: the booking exists with the
 * supplier, but the customer has not yet given the formal confirmation that
 * turns it into a contract. That is exactly the state a booked-but-unconfirmed
 * group is in, so the pipeline shows it without anyone opening SETT Hub.
 */
export const BOOKED_STAGE_NAME = process.env['ODOO_BOOKED_STAGE'] ?? 'Optioned';

/**
 * Model holding the SETT Hub reservation references.
 *
 * Prepared on the Odoo side before this integration was built — the client
 * confirmed the fields already existed, and they do.
 */
export const RESERVATION_MODEL = 'x_sett_hub_reservation';

/** Whether writing to Odoo is enabled at all. */
export const ODOO_SALES_ORDER_ENABLED =
    (process.env['ODOO_SALES_ORDER_ENABLED'] ?? 'true').toLowerCase() !== 'false';
