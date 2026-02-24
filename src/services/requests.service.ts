import requestRepository from '../repositories/request.repository';

export class RequestService {
    async getAllRequests() {
        return requestRepository.findAll();
    }

    async getRequestById(id: string) {
        const request = await requestRepository.findById(id);
        if (!request) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }
        return request;
    }

    async updateRequestStatus(id: string, status: string) {
        return requestRepository.updateStatus(id, status);
    }
}

export default new RequestService();
