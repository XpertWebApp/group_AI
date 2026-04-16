import { Prisma } from '@prisma/client';
export declare class ProposalRepository {
    findAll(): Promise<({
        bookingRequest: {
            id: string;
            firstName: string | null;
            lastName: string | null;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.BookingRequestStatus;
            checkinDate: Date;
            referenceNumber: number;
            contactEmail: string | null;
            destinationName: string | null;
            companyName: string | null;
            rawPayload: Prisma.JsonValue;
            externalRequestId: string | null;
            source: string | null;
            sourceIp: string | null;
            budget: Prisma.Decimal | null;
            contactName: string | null;
            contactPhone: string | null;
            contactPhoneCountryCode: string | null;
            currencyCode: string | null;
            destinationId: number;
            nights: number;
            rooms: Prisma.JsonValue | null;
            nationalityCode: string | null;
            processed: boolean;
            processedAt: Date | null;
            specialRequirements: string | null;
            checkoutDate: Date | null;
            starRating: Prisma.Decimal | null;
            budgetRange: string | null;
            groupType: string | null;
            groupSize: number | null;
            averageAge: number | null;
            breakfastPreference: string | null;
            hotelLocation: string | null;
            guestListFileKey: string | null;
            customerNotes: string | null;
            termsAndConditions: string | null;
            cancellationConditions: string | null;
            assignedUserId: string | null;
        } | null;
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    })[]>;
    findById(id: string): Promise<({
        bookingRequest: {
            id: string;
            firstName: string | null;
            lastName: string | null;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.BookingRequestStatus;
            checkinDate: Date;
            referenceNumber: number;
            contactEmail: string | null;
            destinationName: string | null;
            companyName: string | null;
            rawPayload: Prisma.JsonValue;
            externalRequestId: string | null;
            source: string | null;
            sourceIp: string | null;
            budget: Prisma.Decimal | null;
            contactName: string | null;
            contactPhone: string | null;
            contactPhoneCountryCode: string | null;
            currencyCode: string | null;
            destinationId: number;
            nights: number;
            rooms: Prisma.JsonValue | null;
            nationalityCode: string | null;
            processed: boolean;
            processedAt: Date | null;
            specialRequirements: string | null;
            checkoutDate: Date | null;
            starRating: Prisma.Decimal | null;
            budgetRange: string | null;
            groupType: string | null;
            groupSize: number | null;
            averageAge: number | null;
            breakfastPreference: string | null;
            hotelLocation: string | null;
            guestListFileKey: string | null;
            customerNotes: string | null;
            termsAndConditions: string | null;
            cancellationConditions: string | null;
            assignedUserId: string | null;
        } | null;
        hotels: {
            id: string;
            createdAt: Date;
            rooms: Prisma.JsonValue | null;
            deletedAt: Date | null;
            hotelCode: string;
            latitude: Prisma.Decimal | null;
            longitude: Prisma.Decimal | null;
            supplierCode: string | null;
            tid: string | null;
            totalPrice: Prisma.Decimal;
            currency: string;
            freeCancellation: boolean | null;
            proposalId: string;
            includedInTotal: boolean;
            hotelName: string | null;
            cancelDeadline: Date | null;
            optionDetailsId: string | null;
            optionDetailsFetched: boolean;
        }[];
        services: {
            id: string;
            createdAt: Date;
            days: number | null;
            dateFrom: Date | null;
            dateTo: Date | null;
            notes: string | null;
            currency: string | null;
            proposalId: string;
            includedInTotal: boolean;
            serviceName: string | null;
            buyPrice: Prisma.Decimal | null;
            sellPrice: Prisma.Decimal | null;
            quantity: number | null;
        }[];
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }) | null>;
    findHotels(proposalId: string): Promise<{
        id: string;
        createdAt: Date;
        rooms: Prisma.JsonValue | null;
        deletedAt: Date | null;
        hotelCode: string;
        latitude: Prisma.Decimal | null;
        longitude: Prisma.Decimal | null;
        supplierCode: string | null;
        tid: string | null;
        totalPrice: Prisma.Decimal;
        currency: string;
        freeCancellation: boolean | null;
        proposalId: string;
        includedInTotal: boolean;
        hotelName: string | null;
        cancelDeadline: Date | null;
        optionDetailsId: string | null;
        optionDetailsFetched: boolean;
    }[]>;
    createForRequest(requestId: string, data: {
        notes?: string;
        markupSettings?: any;
    }): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    create(data: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    update(id: string, data: any): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    updateMetadata(id: string, data: {
        notes?: string;
        markupSettings?: any;
    }): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    /**
     * Atomically adds a hotel and recalculates proposal totals.
     * Uses a Prisma transaction so the insert + totals update are an atomic unit.
     */
    addHotelTx(proposalId: string, hotelData: {
        hotelCode: string;
        hotelName?: string;
        tid?: string;
        rooms?: any;
        currency: string;
        totalPrice: number;
        freeCancellation?: boolean;
        cancelDeadline?: string | null;
        supplierCode?: string;
        optionDetailsId?: string;
        latitude?: number | null;
        longitude?: number | null;
    }, markupSettings?: any): Promise<{
        hotel: {
            id: string;
            createdAt: Date;
            rooms: Prisma.JsonValue | null;
            deletedAt: Date | null;
            hotelCode: string;
            latitude: Prisma.Decimal | null;
            longitude: Prisma.Decimal | null;
            supplierCode: string | null;
            tid: string | null;
            totalPrice: Prisma.Decimal;
            currency: string;
            freeCancellation: boolean | null;
            proposalId: string;
            includedInTotal: boolean;
            hotelName: string | null;
            cancelDeadline: Date | null;
            optionDetailsId: string | null;
            optionDetailsFetched: boolean;
        };
        proposal: {
            id: string;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.ProposalStatus;
            requestId: string | null;
            totalBuy: Prisma.Decimal | null;
            totalSell: Prisma.Decimal | null;
            markupSettings: Prisma.JsonValue | null;
            notes: string | null;
            lockedAt: Date | null;
            lockedBy: string | null;
            sentAt: Date | null;
            sentBy: string | null;
            sentToEmail: string | null;
            approvedAt: Date | null;
            approvedBy: string | null;
            rejectedAt: Date | null;
            rejectedBy: string | null;
            rejectionReason: string | null;
            pdfUrl: string | null;
        };
    }>;
    /**
     * Soft-deletes a proposal hotel and recalculates totals atomically.
     */
    removeHotelTx(proposalId: string, hotelId: string, snapshot: any): Promise<{
        hotel: {
            id: string;
            createdAt: Date;
            rooms: Prisma.JsonValue | null;
            deletedAt: Date | null;
            hotelCode: string;
            latitude: Prisma.Decimal | null;
            longitude: Prisma.Decimal | null;
            supplierCode: string | null;
            tid: string | null;
            totalPrice: Prisma.Decimal;
            currency: string;
            freeCancellation: boolean | null;
            proposalId: string;
            includedInTotal: boolean;
            hotelName: string | null;
            cancelDeadline: Date | null;
            optionDetailsId: string | null;
            optionDetailsFetched: boolean;
        };
        proposal: {
            id: string;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.ProposalStatus;
            requestId: string | null;
            totalBuy: Prisma.Decimal | null;
            totalSell: Prisma.Decimal | null;
            markupSettings: Prisma.JsonValue | null;
            notes: string | null;
            lockedAt: Date | null;
            lockedBy: string | null;
            sentAt: Date | null;
            sentBy: string | null;
            sentToEmail: string | null;
            approvedAt: Date | null;
            approvedBy: string | null;
            rejectedAt: Date | null;
            rejectedBy: string | null;
            rejectionReason: string | null;
            pdfUrl: string | null;
        };
    }>;
    /**
     * Adds a service and recalculates totals atomically.
     */
    addServiceTx(proposalId: string, serviceData: {
        serviceName: string;
        dateFrom?: string | null;
        dateTo?: string | null;
        buyPrice?: number;
        sellPrice?: number;
        quantity?: number;
        days?: number;
        notes?: string;
    }, markupSettings?: any): Promise<{
        service: {
            id: string;
            createdAt: Date;
            days: number | null;
            dateFrom: Date | null;
            dateTo: Date | null;
            notes: string | null;
            currency: string | null;
            proposalId: string;
            includedInTotal: boolean;
            serviceName: string | null;
            buyPrice: Prisma.Decimal | null;
            sellPrice: Prisma.Decimal | null;
            quantity: number | null;
        };
        proposal: {
            id: string;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.ProposalStatus;
            requestId: string | null;
            totalBuy: Prisma.Decimal | null;
            totalSell: Prisma.Decimal | null;
            markupSettings: Prisma.JsonValue | null;
            notes: string | null;
            lockedAt: Date | null;
            lockedBy: string | null;
            sentAt: Date | null;
            sentBy: string | null;
            sentToEmail: string | null;
            approvedAt: Date | null;
            approvedBy: string | null;
            rejectedAt: Date | null;
            rejectedBy: string | null;
            rejectionReason: string | null;
            pdfUrl: string | null;
        };
    }>;
    /**
     * Updates a service and recalculates totals atomically.
     */
    updateServiceTx(proposalId: string, serviceId: string, serviceData: {
        serviceName?: string;
        dateFrom?: string | null;
        dateTo?: string | null;
        buyPrice?: number;
        sellPrice?: number;
        quantity?: number;
        days?: number;
        notes?: string;
        includedInTotal?: boolean;
    }): Promise<{
        service: {
            id: string;
            createdAt: Date;
            days: number | null;
            dateFrom: Date | null;
            dateTo: Date | null;
            notes: string | null;
            currency: string | null;
            proposalId: string;
            includedInTotal: boolean;
            serviceName: string | null;
            buyPrice: Prisma.Decimal | null;
            sellPrice: Prisma.Decimal | null;
            quantity: number | null;
        };
        proposal: {
            id: string;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.ProposalStatus;
            requestId: string | null;
            totalBuy: Prisma.Decimal | null;
            totalSell: Prisma.Decimal | null;
            markupSettings: Prisma.JsonValue | null;
            notes: string | null;
            lockedAt: Date | null;
            lockedBy: string | null;
            sentAt: Date | null;
            sentBy: string | null;
            sentToEmail: string | null;
            approvedAt: Date | null;
            approvedBy: string | null;
            rejectedAt: Date | null;
            rejectedBy: string | null;
            rejectionReason: string | null;
            pdfUrl: string | null;
        };
    } | null>;
    /**
     * Deletes a service and recalculates totals atomically.
     */
    removeServiceTx(proposalId: string, serviceId: string): Promise<{
        proposal: {
            id: string;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.ProposalStatus;
            requestId: string | null;
            totalBuy: Prisma.Decimal | null;
            totalSell: Prisma.Decimal | null;
            markupSettings: Prisma.JsonValue | null;
            notes: string | null;
            lockedAt: Date | null;
            lockedBy: string | null;
            sentAt: Date | null;
            sentBy: string | null;
            sentToEmail: string | null;
            approvedAt: Date | null;
            approvedBy: string | null;
            rejectedAt: Date | null;
            rejectedBy: string | null;
            rejectionReason: string | null;
            pdfUrl: string | null;
        };
    } | null>;
    adjustHotelPricing(proposalId: string, hotelId: string, data: {
        rooms?: any;
        totalPrice?: number;
        currency?: string;
    }): Promise<{
        hotel: {
            id: string;
            createdAt: Date;
            rooms: Prisma.JsonValue | null;
            deletedAt: Date | null;
            hotelCode: string;
            latitude: Prisma.Decimal | null;
            longitude: Prisma.Decimal | null;
            supplierCode: string | null;
            tid: string | null;
            totalPrice: Prisma.Decimal;
            currency: string;
            freeCancellation: boolean | null;
            proposalId: string;
            includedInTotal: boolean;
            hotelName: string | null;
            cancelDeadline: Date | null;
            optionDetailsId: string | null;
            optionDetailsFetched: boolean;
        };
        proposal: {
            id: string;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.ProposalStatus;
            requestId: string | null;
            totalBuy: Prisma.Decimal | null;
            totalSell: Prisma.Decimal | null;
            markupSettings: Prisma.JsonValue | null;
            notes: string | null;
            lockedAt: Date | null;
            lockedBy: string | null;
            sentAt: Date | null;
            sentBy: string | null;
            sentToEmail: string | null;
            approvedAt: Date | null;
            approvedBy: string | null;
            rejectedAt: Date | null;
            rejectedBy: string | null;
            rejectionReason: string | null;
            pdfUrl: string | null;
        };
    }>;
    /**
     * Toggle whether a hotel is included in the proposal grand total.
     * Used for Oliver's "options" feature where multiple hotels can be offered
     * but only checked ones contribute to the customer-facing total.
     */
    toggleHotelIncluded(proposalId: string, hotelId: string, includedInTotal: boolean): Promise<{
        hotel: {
            id: string;
            createdAt: Date;
            rooms: Prisma.JsonValue | null;
            deletedAt: Date | null;
            hotelCode: string;
            latitude: Prisma.Decimal | null;
            longitude: Prisma.Decimal | null;
            supplierCode: string | null;
            tid: string | null;
            totalPrice: Prisma.Decimal;
            currency: string;
            freeCancellation: boolean | null;
            proposalId: string;
            includedInTotal: boolean;
            hotelName: string | null;
            cancelDeadline: Date | null;
            optionDetailsId: string | null;
            optionDetailsFetched: boolean;
        };
        proposal: {
            id: string;
            createdAt: Date;
            updatedAt: Date | null;
            status: import(".prisma/client").$Enums.ProposalStatus;
            requestId: string | null;
            totalBuy: Prisma.Decimal | null;
            totalSell: Prisma.Decimal | null;
            markupSettings: Prisma.JsonValue | null;
            notes: string | null;
            lockedAt: Date | null;
            lockedBy: string | null;
            sentAt: Date | null;
            sentBy: string | null;
            sentToEmail: string | null;
            approvedAt: Date | null;
            approvedBy: string | null;
            rejectedAt: Date | null;
            rejectedBy: string | null;
            rejectionReason: string | null;
            pdfUrl: string | null;
        };
    }>;
    /**
     * Atomically acquires a lock on a proposal.
     * Uses updateMany with a conditional WHERE to prevent lost-update races.
     * Returns null if the lock could not be acquired (i.e. already locked by another user).
     */
    acquireLock(proposalId: string, userId: string): Promise<any | null>;
    /**
     * Releases the lock on a proposal. Only the lock owner can unlock.
     */
    releaseLock(proposalId: string, userId: string): Promise<Prisma.BatchPayload>;
    setDraft(id: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    setSent(id: string, sentBy: string, sentToEmail?: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    setPendingAdminApproval(id: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    setApproved(id: string, approvedBy: string, pdfUrl?: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    setDeclined(id: string, rejectedBy: string, rejectionReason: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date | null;
        status: import(".prisma/client").$Enums.ProposalStatus;
        requestId: string | null;
        totalBuy: Prisma.Decimal | null;
        totalSell: Prisma.Decimal | null;
        markupSettings: Prisma.JsonValue | null;
        notes: string | null;
        lockedAt: Date | null;
        lockedBy: string | null;
        sentAt: Date | null;
        sentBy: string | null;
        sentToEmail: string | null;
        approvedAt: Date | null;
        approvedBy: string | null;
        rejectedAt: Date | null;
        rejectedBy: string | null;
        rejectionReason: string | null;
        pdfUrl: string | null;
    }>;
    addHotel(proposalId: string, hotelData: any): Promise<{
        id: string;
        createdAt: Date;
        rooms: Prisma.JsonValue | null;
        deletedAt: Date | null;
        hotelCode: string;
        latitude: Prisma.Decimal | null;
        longitude: Prisma.Decimal | null;
        supplierCode: string | null;
        tid: string | null;
        totalPrice: Prisma.Decimal;
        currency: string;
        freeCancellation: boolean | null;
        proposalId: string;
        includedInTotal: boolean;
        hotelName: string | null;
        cancelDeadline: Date | null;
        optionDetailsId: string | null;
        optionDetailsFetched: boolean;
    }>;
    addService(proposalId: string, serviceData: any): Promise<{
        id: string;
        createdAt: Date;
        days: number | null;
        dateFrom: Date | null;
        dateTo: Date | null;
        notes: string | null;
        currency: string | null;
        proposalId: string;
        includedInTotal: boolean;
        serviceName: string | null;
        buyPrice: Prisma.Decimal | null;
        sellPrice: Prisma.Decimal | null;
        quantity: number | null;
    }>;
    /** Count how many offers have been sent for this proposal. */
    countOffers(proposalId: string): Promise<number>;
    /** Create a new ProposalOffer history row. */
    createOffer(data: {
        proposalId: string;
        offerNumber: number;
        type: string;
        pdfKey: string;
        pdfUrl: string;
        sentBy: string;
        sentToEmails: string[];
        hotelSnapshot?: any;
        serviceSnapshot?: any;
        totalPrice?: number | null;
        currency?: string | null;
        method?: string | null;
    }): Promise<{
        method: string | null;
        id: string;
        createdAt: Date;
        type: string;
        sentAt: Date;
        sentBy: string;
        pdfUrl: string;
        totalPrice: Prisma.Decimal | null;
        currency: string | null;
        proposalId: string;
        offerNumber: number;
        pdfKey: string;
        sentToEmails: string[];
        hotelSnapshot: Prisma.JsonValue | null;
        serviceSnapshot: Prisma.JsonValue | null;
    }>;
    /** List all offers for a proposal (oldest first by offerNumber). */
    listOffers(proposalId: string): Promise<{
        method: string | null;
        id: string;
        createdAt: Date;
        type: string;
        sentAt: Date;
        sentBy: string;
        pdfUrl: string;
        totalPrice: Prisma.Decimal | null;
        currency: string | null;
        proposalId: string;
        offerNumber: number;
        pdfKey: string;
        sentToEmails: string[];
        hotelSnapshot: Prisma.JsonValue | null;
        serviceSnapshot: Prisma.JsonValue | null;
    }[]>;
    /** Fetch a single offer by id. */
    getOfferById(offerId: string): Promise<{
        method: string | null;
        id: string;
        createdAt: Date;
        type: string;
        sentAt: Date;
        sentBy: string;
        pdfUrl: string;
        totalPrice: Prisma.Decimal | null;
        currency: string | null;
        proposalId: string;
        offerNumber: number;
        pdfKey: string;
        sentToEmails: string[];
        hotelSnapshot: Prisma.JsonValue | null;
        serviceSnapshot: Prisma.JsonValue | null;
    } | null>;
}
declare const _default: ProposalRepository;
export default _default;
