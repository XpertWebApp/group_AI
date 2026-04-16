declare class StorageService {
    private client;
    private getClient;
    uploadFile(key: string, buffer: Buffer, contentType: string): Promise<string>;
    deleteFile(key: string): Promise<void>;
    uploadPdf(proposalId: string, filename: string, pdfBuffer: Buffer): Promise<string>;
    downloadPdf(key: string): Promise<Buffer>;
    deletePdf(key: string): Promise<void>;
}
declare const _default: StorageService;
export default _default;
