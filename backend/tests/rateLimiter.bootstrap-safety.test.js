const path = require('path');

describe('rate limiter bootstrap safety security scenario', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('does not throw at import when Redis client is not initialized', () => {
    const redisConfigPath = path.resolve(__dirname, '../scripts/config/redis.js');
    jest.doMock(redisConfigPath, () => ({
      getRedisClient: () => { throw new Error('Redis başlatılmamış. Önce connectRedis() çağrılmalı.'); },
      isReady: () => false,
    }));

    expect(() => require('../scripts/middleware/rateLimiter')).not.toThrow();
  });
});
