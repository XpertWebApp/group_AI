/**
 * Acceptance test harness for the Phase 1 SMTP rollout.
 *
 * Fires one synthetic email per Phase 1 trigger so we can verify with Oliver that:
 *   - Brevo connection works
 *   - Sender displays as "SETT Groups <groups@s-e-t-t.com>"
 *   - Reply-To routes correctly (Read B rule: customer-facing → group inbox; staff-internal → assigned staff fallback)
 *   - All templates carry the "Quote within 24 hours" promise
 *   - Each trigger fires independently
 *
 * Usage:
 *   TEST_RECIPIENT=oliver@s-e-t-t.com ts-node scripts/email-acceptance-test.ts
 *
 *   # Optional second pass against an external recipient for the spam check:
 *   TEST_RECIPIENT=your-personal@gmail.com ts-node scripts/email-acceptance-test.ts
 *
 * Notes:
 *   - The script does NOT touch the database. Each call goes straight through the
 *     branded template + sendEmail pipeline, so retry + dead-letter logic is exercised
 *     too if Brevo is misconfigured.
 *   - Reference numbers are synthetic (e.g. 99001) so they don't collide with real
 *     requests.
 *   - Run AFTER setting up `.env` with valid Brevo credentials.
 */

import 'dotenv/config';
import notificationService from '../src/services/notification.service';
import {
    buildNewRequestStaffEmail,
    buildNewRequestContactEmail,
    buildOfferApprovedEmail,
    buildOfferDeclinedContactEmail,
    buildOfferDeclinedEmail,
    buildOfferPdfEmail,
    buildStatusChangeEmail,
} from '../src/services/emailTemplate';

const RECIPIENT = process.env.TEST_RECIPIENT;

if (!RECIPIENT) {
    console.error('ERROR: TEST_RECIPIENT env var is required.');
    console.error('Example: TEST_RECIPIENT=oliver@s-e-t-t.com ts-node scripts/email-acceptance-test.ts');
    process.exit(1);
}

const SAMPLE = {
    referenceNumber: 99001,
    contactName: 'Acme Football Club',
    destinationName: 'Copenhagen',
    rejectionReason: 'No availability matching the requested dates and budget.',
};

const REPLY_GROUP = process.env.SMTP_REPLY_TO_FALLBACK ?? 'groups@s-e-t-t.com';

interface TestCase {
    name: string;
    eventType: string;
    customerFacing: boolean;
    subject: string;
    html: string;
    attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

const cases: TestCase[] = [
    {
        name: '1. New request via portal — staff alert',
        eventType: 'new_request_staff',
        customerFacing: false,
        subject: `New group request received (#${SAMPLE.referenceNumber})`,
        html: buildNewRequestStaffEmail({ ...SAMPLE, source: 'portal form (acceptance test)' }),
    },
    {
        name: '2. New request via webhook — staff alert',
        eventType: 'new_request_staff',
        customerFacing: false,
        subject: `New group request received (#${SAMPLE.referenceNumber})`,
        html: buildNewRequestStaffEmail({ ...SAMPLE, source: 'Wix webhook (acceptance test)' }),
    },
    {
        name: '3. New request — customer confirmation',
        eventType: 'new_request_contact',
        customerFacing: true,
        subject: `We've received your enquiry — Reference #${SAMPLE.referenceNumber}`,
        html: buildNewRequestContactEmail(SAMPLE),
    },
    {
        name: '4. Offer sent — customer PDF (no real PDF in this test)',
        eventType: 'offer_sent_contact',
        customerFacing: true,
        subject: `Your Group Offer #${SAMPLE.referenceNumber} — ${SAMPLE.destinationName}`,
        html: buildOfferPdfEmail(SAMPLE),
        // No attachment in the acceptance test — we just want to verify deliverability.
    },
    {
        name: '5. Approval — staff alert',
        eventType: 'offer_approved',
        customerFacing: false,
        subject: `Offer #${SAMPLE.referenceNumber} approved`,
        html: buildOfferApprovedEmail({ ...SAMPLE, approvedBy: 'acceptance-test-user' }),
    },
    {
        name: '6a. Rejection — staff alert',
        eventType: 'offer_declined_staff',
        customerFacing: false,
        subject: `Offer #${SAMPLE.referenceNumber} declined — ${SAMPLE.rejectionReason}`,
        html: buildOfferDeclinedEmail(SAMPLE),
    },
    {
        name: '6b. Rejection — customer notice',
        eventType: 'offer_declined_contact',
        customerFacing: true,
        subject: `Update on your group offer — Reference #${SAMPLE.referenceNumber}`,
        html: buildOfferDeclinedContactEmail(SAMPLE),
    },
    {
        name: '7. Status update — staff alert (sent)',
        eventType: 'status_change_sent',
        customerFacing: false,
        subject: `Request #${SAMPLE.referenceNumber} → sent`,
        html: buildStatusChangeEmail({ ...SAMPLE, fromStatus: 'ai_generated', toStatus: 'sent' }),
    },
];

async function run() {
    console.log(`\nFiring ${cases.length} acceptance-test emails to: ${RECIPIENT}\n`);
    console.log(`Sender (FROM):       ${process.env.SMTP_FROM ?? '<unset — defaults to SETT Groups <groups@s-e-t-t.com>>'}`);
    console.log(`Reply-To fallback:   ${REPLY_GROUP}`);
    console.log(`SMTP host:           ${process.env.SMTP_HOST ?? '<unset — emails will be skipped>'}`);
    console.log('');

    let pass = 0;
    let fail = 0;

    for (const tc of cases) {
        const replyTo = tc.customerFacing ? REPLY_GROUP : REPLY_GROUP;
        // Both default to the group inbox for this acceptance test, since synthetic
        // requests have no assigned staff. Real production traffic gets dynamic
        // staff Reply-To via resolveStaffReplyTo() when a request is owned.
        process.stdout.write(`▸ ${tc.name} ... `);

        const result = await notificationService.sendEmail({
            eventType: tc.eventType,
            to: RECIPIENT!,
            subject: tc.subject,
            html: tc.html,
            replyTo,
            attachments: tc.attachments,
        });

        if (result.ok) {
            pass++;
            console.log('OK');
        } else {
            fail++;
            console.log(`FAILED — ${result.failure.code}: ${result.failure.detail ?? result.failure.message}`);
        }
    }

    console.log(`\nResult: ${pass} sent, ${fail} failed (out of ${cases.length}).\n`);
    if (fail > 0) {
        console.log('Check failed_emails table + server logs for details.');
        process.exit(1);
    }
    process.exit(0);
}

run().catch((err) => {
    console.error('Acceptance test runner crashed:', err);
    process.exit(2);
});
