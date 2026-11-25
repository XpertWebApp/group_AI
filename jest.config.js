module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.ts'],
    // The e2e suite drives a running server on localhost:4000 and makes live
    // WBE calls, so it cannot run as part of the default unit-test pass — a
    // stopped server would fail it for reasons unrelated to the code under
    // test. Run it deliberately with `npm run test:e2e`.
    testPathIgnorePatterns: ['/node_modules/', '/dist/', 'e2e-hotel-search\\.test\\.ts$'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
};
