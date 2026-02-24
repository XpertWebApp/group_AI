import request from 'supertest';
import app from '../app';

describe('Auth Endpoints', () => {
    it('should return 400 for login with no credentials', async () => {
        const res = await request(app).post('/api/v1/auth/login').send({});
        // Should fail with 401 as per our auth service logic (or 500 if unhandled, but middleware should handle it)
        expect(res.status).toBe(400);
    });

    it('should return 401 for unauthorized access to requests', async () => {
        const res = await request(app).get('/api/v1/requests');
        expect(res.status).toBe(401);
    });
});
