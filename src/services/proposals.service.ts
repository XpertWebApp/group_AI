import proposalRepository from '../repositories/proposal.repository';

export class ProposalService {
    async getAllProposals() {
        return proposalRepository.findAll();
    }

    async getProposalById(id: string) {
        const proposal = await proposalRepository.findById(id);
        if (!proposal) {
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        }
        return proposal;
    }

    async createProposal(data: any) {
        return proposalRepository.create(data);
    }

    async addHotelToProposal(id: string, hotelData: any) {
        return proposalRepository.addHotel(id, hotelData);
    }

    async addServiceToProposal(id: string, serviceData: any) {
        return proposalRepository.addService(id, serviceData);
    }

    async updateProposalStatus(id: string, status: string) {
        return proposalRepository.update(id, { status });
    }
}

export default new ProposalService();
