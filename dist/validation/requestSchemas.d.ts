import { z } from 'zod';
export declare const RoomsSchema: z.ZodObject<{
    single: z.ZodDefault<z.ZodNumber>;
    double: z.ZodDefault<z.ZodNumber>;
    twin: z.ZodDefault<z.ZodNumber>;
    triple: z.ZodDefault<z.ZodNumber>;
    quadruple: z.ZodDefault<z.ZodNumber>;
    suites: z.ZodDefault<z.ZodNumber>;
    standardDoubleBeds: z.ZodDefault<z.ZodNumber>;
    twinBeds: z.ZodDefault<z.ZodNumber>;
    extraRoomsNote: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const CreateBookingRequestSchema: z.ZodObject<{
    destinationId: z.ZodNumber;
    destinationName: z.ZodString;
    checkinDate: z.ZodString;
    checkoutDate: z.ZodOptional<z.ZodString>;
    nights: z.ZodOptional<z.ZodNumber>;
    starRating: z.ZodOptional<z.ZodNumber>;
    budgetRange: z.ZodOptional<z.ZodString>;
    budget: z.ZodOptional<z.ZodNumber>;
    groupType: z.ZodOptional<z.ZodString>;
    groupSize: z.ZodOptional<z.ZodNumber>;
    averageAge: z.ZodOptional<z.ZodNumber>;
    currencyCode: z.ZodOptional<z.ZodString>;
    nationalityCode: z.ZodOptional<z.ZodString>;
    rooms: z.ZodOptional<z.ZodObject<{
        single: z.ZodDefault<z.ZodNumber>;
        double: z.ZodDefault<z.ZodNumber>;
        twin: z.ZodDefault<z.ZodNumber>;
        triple: z.ZodDefault<z.ZodNumber>;
        quadruple: z.ZodDefault<z.ZodNumber>;
        suites: z.ZodDefault<z.ZodNumber>;
        standardDoubleBeds: z.ZodDefault<z.ZodNumber>;
        twinBeds: z.ZodDefault<z.ZodNumber>;
        extraRoomsNote: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
    breakfastPreference: z.ZodOptional<z.ZodEnum<{
        BB: "BB";
        RO: "RO";
    }>>;
    hotelLocation: z.ZodOptional<z.ZodEnum<{
        central: "central";
        outside_city_center: "outside_city_center";
    }>>;
    specialRequirements: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    companyName: z.ZodString;
    firstName: z.ZodString;
    lastName: z.ZodString;
    contactName: z.ZodOptional<z.ZodString>;
    contactEmail: z.ZodString;
    contactPhone: z.ZodString;
    contactPhoneCountryCode: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    guestListFileKey: z.ZodOptional<z.ZodString>;
    customerNotes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    termsAndConditions: z.ZodOptional<z.ZodString>;
    cancellationConditions: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        pending: "pending";
        draft: "draft";
    }>>;
}, z.core.$strip>;
export declare const UpdateBookingRequestSchema: z.ZodObject<{
    destinationId: z.ZodOptional<z.ZodNumber>;
    destinationName: z.ZodOptional<z.ZodString>;
    checkinDate: z.ZodOptional<z.ZodString>;
    checkoutDate: z.ZodOptional<z.ZodString>;
    nights: z.ZodOptional<z.ZodNumber>;
    starRating: z.ZodOptional<z.ZodNumber>;
    budgetRange: z.ZodOptional<z.ZodString>;
    budget: z.ZodOptional<z.ZodNumber>;
    groupType: z.ZodOptional<z.ZodString>;
    groupSize: z.ZodOptional<z.ZodNumber>;
    averageAge: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    currencyCode: z.ZodOptional<z.ZodString>;
    nationalityCode: z.ZodOptional<z.ZodString>;
    rooms: z.ZodOptional<z.ZodObject<{
        single: z.ZodDefault<z.ZodNumber>;
        double: z.ZodDefault<z.ZodNumber>;
        twin: z.ZodDefault<z.ZodNumber>;
        triple: z.ZodDefault<z.ZodNumber>;
        quadruple: z.ZodDefault<z.ZodNumber>;
        suites: z.ZodDefault<z.ZodNumber>;
        standardDoubleBeds: z.ZodDefault<z.ZodNumber>;
        twinBeds: z.ZodDefault<z.ZodNumber>;
        extraRoomsNote: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
    breakfastPreference: z.ZodOptional<z.ZodEnum<{
        BB: "BB";
        RO: "RO";
    }>>;
    hotelLocation: z.ZodOptional<z.ZodEnum<{
        central: "central";
        outside_city_center: "outside_city_center";
    }>>;
    specialRequirements: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    companyName: z.ZodOptional<z.ZodString>;
    firstName: z.ZodOptional<z.ZodString>;
    lastName: z.ZodOptional<z.ZodString>;
    contactName: z.ZodOptional<z.ZodString>;
    contactEmail: z.ZodOptional<z.ZodString>;
    contactPhone: z.ZodOptional<z.ZodString>;
    contactPhoneCountryCode: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    guestListFileKey: z.ZodOptional<z.ZodString>;
    customerNotes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    termsAndConditions: z.ZodOptional<z.ZodString>;
    cancellationConditions: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        pending: "pending";
        draft: "draft";
        processing: "processing";
        completed: "completed";
        cancelled: "cancelled";
        ai_generated: "ai_generated";
        sent: "sent";
        declined: "declined";
    }>>;
}, z.core.$strip>;
export declare const ListRequestsQuerySchema: z.ZodObject<{
    page: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number, string | undefined>>;
    limit: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number, string | undefined>>;
    search: z.ZodOptional<z.ZodString>;
    status: z.ZodPipe<z.ZodOptional<z.ZodEnum<{
        "": "";
        pending: "pending";
        draft: "draft";
        processing: "processing";
        completed: "completed";
        cancelled: "cancelled";
        ai_generated: "ai_generated";
        sent: "sent";
        declined: "declined";
    }>>, z.ZodTransform<"pending" | "draft" | "processing" | "completed" | "cancelled" | "ai_generated" | "sent" | "declined" | undefined, "" | "pending" | "draft" | "processing" | "completed" | "cancelled" | "ai_generated" | "sent" | "declined" | undefined>>;
    dateFrom: z.ZodOptional<z.ZodString>;
    dateTo: z.ZodOptional<z.ZodString>;
    sortBy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        createdAt: "createdAt";
        checkinDate: "checkinDate";
        referenceNumber: "referenceNumber";
    }>>>;
    sortOrder: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>>;
}, z.core.$strip>;
export declare const CreateProposalSchema: z.ZodObject<{
    notes: z.ZodOptional<z.ZodString>;
    markupSettings: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
}, z.core.$strip>;
export declare const UpdateProposalSchema: z.ZodObject<{
    notes: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    markupSettings: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>>;
}, z.core.$strip>;
export declare const AddProposalHotelSchema: z.ZodObject<{
    hotelCode: z.ZodString;
    hotelName: z.ZodOptional<z.ZodString>;
    tid: z.ZodOptional<z.ZodString>;
    rooms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        net: z.ZodNumber;
        sell: z.ZodNumber;
        qty: z.ZodNumber;
        nights: z.ZodNumber;
    }, z.core.$strip>>>;
    currency: z.ZodString;
    totalPrice: z.ZodNumber;
    freeCancellation: z.ZodOptional<z.ZodBoolean>;
    cancelDeadline: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    supplierCode: z.ZodOptional<z.ZodString>;
    optionDetailsId: z.ZodOptional<z.ZodString>;
    latitude: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
    longitude: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
}, z.core.$strip>;
export declare const AdjustHotelPricingSchema: z.ZodObject<{
    rooms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        net: z.ZodOptional<z.ZodNumber>;
        sell: z.ZodOptional<z.ZodNumber>;
        qty: z.ZodOptional<z.ZodNumber>;
        nights: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    totalPrice: z.ZodOptional<z.ZodNumber>;
    currency: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const AddProposalServiceSchema: z.ZodObject<{
    serviceName: z.ZodString;
    dateFrom: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    dateTo: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    buyPrice: z.ZodOptional<z.ZodNumber>;
    sellPrice: z.ZodOptional<z.ZodNumber>;
    quantity: z.ZodOptional<z.ZodNumber>;
    days: z.ZodOptional<z.ZodNumber>;
    notes: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const UpdateProposalServiceSchema: z.ZodObject<{
    serviceName: z.ZodOptional<z.ZodString>;
    dateFrom: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    dateTo: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    buyPrice: z.ZodOptional<z.ZodNumber>;
    sellPrice: z.ZodOptional<z.ZodNumber>;
    quantity: z.ZodOptional<z.ZodNumber>;
    days: z.ZodOptional<z.ZodNumber>;
    notes: z.ZodOptional<z.ZodString>;
    includedInTotal: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ToggleProposalHotelSchema: z.ZodObject<{
    includedInTotal: z.ZodBoolean;
}, z.core.$strip>;
export declare const SendProposalSchema: z.ZodObject<{
    sendToEmail: z.ZodOptional<z.ZodString>;
    sendToEmails: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const ApproveProposalSchema: z.ZodObject<{
    agentEmail: z.ZodOptional<z.ZodString>;
    adminNotes: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const DeclineProposalSchema: z.ZodObject<{
    rejectionReason: z.ZodString;
}, z.core.$strip>;
export declare const UpdateGeneralConfigSchema: z.ZodObject<{
    defaultMarkupPercentage: z.ZodString;
}, z.core.$strip>;
export declare const UpdateEmailConfigSchema: z.ZodObject<{
    smtpHost: z.ZodString;
    smtpPort: z.ZodString;
    smtpUsername: z.ZodString;
    smtpPassword: z.ZodOptional<z.ZodString>;
    fromEmail: z.ZodString;
    fromName: z.ZodString;
}, z.core.$strip>;
export declare const UpdateCompanyDetailsSchema: z.ZodObject<{
    companyName: z.ZodString;
    assignedPerson: z.ZodString;
    emailAddress: z.ZodString;
    phoneNumber: z.ZodString;
    phoneCountryCode: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    website: z.ZodString;
    taxId: z.ZodString;
    address: z.ZodString;
}, z.core.$strip>;
export declare const UpdatePoliciesSchema: z.ZodObject<{
    termsConditionsEn: z.ZodOptional<z.ZodString>;
    termsConditionsDe: z.ZodOptional<z.ZodString>;
    cancellationConditionsEn: z.ZodOptional<z.ZodString>;
    cancellationConditionsDe: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const UpdateSupplierLimitSchema: z.ZodObject<{
    maxRooms: z.ZodOptional<z.ZodNumber>;
    groupsAllowed: z.ZodOptional<z.ZodBoolean>;
    notes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const SupplierLimitsQuerySchema: z.ZodObject<{
    search: z.ZodOptional<z.ZodString>;
    page: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number, string | undefined>>;
    limit: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number, string | undefined>>;
}, z.core.$strip>;
export declare const HotelSearchQuerySchema: z.ZodObject<{
    q: z.ZodOptional<z.ZodString>;
    destinationId: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number | undefined, string | undefined>>;
    starRating: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number | undefined, string | undefined>>;
    limit: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number, string | undefined>>;
    offset: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<number, string | undefined>>;
}, z.core.$strip>;
export declare const WbeHotelSearchSchema: z.ZodObject<{
    mealType: z.ZodOptional<z.ZodEnum<{
        BB: "BB";
        RO: "RO";
        HB: "HB";
        FB: "FB";
        AI: "AI";
    }>>;
    includeAlternativeStars: z.ZodOptional<z.ZodBoolean>;
    waitSeconds: z.ZodOptional<z.ZodNumber>;
    currencyCode: z.ZodOptional<z.ZodString>;
    nationalityCode: z.ZodOptional<z.ZodString>;
    facilityIds: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
}, z.core.$strip>;
export declare const OptionDetailsRequestSchema: z.ZodObject<{
    selections: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        tid: z.ZodString;
        hotelCode: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const PriceCalculationSchema: z.ZodObject<{
    buyingPrice: z.ZodNumber;
    markupPercent: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
