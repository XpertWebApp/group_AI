"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestsController = void 0;
const requests_service_1 = __importDefault(require("../services/requests.service"));
const proposals_service_1 = __importDefault(require("../services/proposals.service"));
const request_repository_1 = __importDefault(require("../repositories/request.repository"));
const response_1 = require("../utils/response");
class RequestsController {
    async list(req, res, next) {
        try {
            const q = req.validated?.query ?? req.query;
            const result = await requests_service_1.default.getAllRequests({
                page: q.page ? Number(q.page) : 1,
                limit: q.limit ? Math.min(Number(q.limit), 100) : 20,
                search: q.search,
                status: q.status,
                dateFrom: q.dateFrom,
                dateTo: q.dateTo,
                sortBy: q.sortBy ?? 'createdAt',
                sortOrder: q.sortOrder ?? 'desc',
            });
            return (0, response_1.sendResponse)(res, 200, result, 'Requests retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    async get(req, res, next) {
        try {
            const result = await requests_service_1.default.getRequestById(req.params['id']);
            return (0, response_1.sendResponse)(res, 200, result, 'Request retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    async getSummary(req, res, next) {
        try {
            const result = await requests_service_1.default.getSummary(req.params['id']);
            return (0, response_1.sendResponse)(res, 200, result, 'Request summary retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    async create(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const ip = req.ip;
            const result = await requests_service_1.default.createRequest(body, userId, ip);
            res.setHeader('Location', `/api/v1/requests/${result.id}`);
            return (0, response_1.sendResponse)(res, 201, result, 'Booking request created');
        }
        catch (error) {
            next(error);
        }
    }
    async update(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const result = await requests_service_1.default.updateRequest(req.params['id'], body, userId);
            return (0, response_1.sendResponse)(res, 200, result, 'Booking request updated');
        }
        catch (error) {
            next(error);
        }
    }
    async updateStatus(req, res, next) {
        try {
            const result = await requests_service_1.default.updateRequestStatus(req.params['id'], req.body.status);
            return (0, response_1.sendResponse)(res, 200, result, 'Request status updated');
        }
        catch (error) {
            next(error);
        }
    }
    async createProposal(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const ip = req.ip;
            const result = await proposals_service_1.default.createForRequest(req.params['requestId'], body, userId, ip);
            res.setHeader('Location', `/api/v1/proposals/${result.id}`);
            return (0, response_1.sendResponse)(res, 201, result, 'Proposal created');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * Explicit self-claim. 200 if claimed (or already owned by the same user),
     * 409 if another user already owns it.
     */
    async claim(req, res, next) {
        try {
            const requestId = req.params['id'];
            const userId = req.user?.id;
            if (!userId) {
                return (0, response_1.sendResponse)(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            }
            const result = await requests_service_1.default.claimOwnershipIfUnassigned(requestId, userId, req.ip, 'explicit');
            if (!result.claimed && result.ownerId && result.ownerId !== userId) {
                const owner = await request_repository_1.default.findOwner(requestId);
                return (0, response_1.sendResponse)(res, 409, { owner }, 'Request already assigned');
            }
            const owner = await request_repository_1.default.findOwner(requestId);
            return (0, response_1.sendResponse)(res, 200, { owner }, result.claimed ? 'Claimed' : 'Already owned by you');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.RequestsController = RequestsController;
exports.default = new RequestsController();
