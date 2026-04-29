const fs = require('fs');
const path = require('path');

describe('Health provider cache and workflow RPC config', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.HEALTH_PROVIDER_BLOCK_CACHE_MS = '15000';
  });

  test('readiness uses provider block cache within TTL', async () => {
    const { getReadiness, updateRuntimeState } = require('../scripts/services/health');
    updateRuntimeState({ serverListening: true, dbReady: true, redisReady: true, protocolConfigReady: true, workerReady: true, degraded: false });
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(123) };
    await getReadiness({ provider, worker: { isRunning: true, _state: 'live' } });
    await getReadiness({ provider, worker: { isRunning: true, _state: 'live' } });
    expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
  });

  test('deployment workflows include RPC saving envs and remove EVENT_QUERY_BLOCK_RANGE=10', () => {
    const base = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy-base-sepolia.yml'), 'utf8');
    const runtime = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy-runtime-base-sepolia.yml'), 'utf8');
    for (const text of [base, runtime]) {
      expect(text).toContain('EVENT_POLL_INTERVAL_MS="60000"');
      expect(text).toContain('EVENT_CONFIRMATIONS="2"');
      expect(text).toContain('EVENT_QUERY_BLOCK_RANGE="500"');
      expect(text).toContain('GET_LOGS_MAX_RETRIES="3"');
      expect(text).toContain('HEALTH_PROVIDER_BLOCK_CACHE_MS="15000"');
      expect(text).not.toContain('EVENT_QUERY_BLOCK_RANGE="10"');
    }
    expect(runtime).toContain('ARAF_DEPLOYMENT_BLOCK cannot be 0 for production runtime deploy.');
  });
});
