const { getReadiness, updateRuntimeState } = require('../scripts/services/health');

describe('readiness degraded mode security scenario', () => {
  test('returns dependency details when protocol/worker are not ready under RPC failure', async () => {
    updateRuntimeState({
      serverListening: true,
      dbReady: true,
      redisReady: true,
      protocolConfigReady: false,
      workerReady: false,
      degraded: true,
    });
    const ready = await getReadiness();
    expect(typeof ready.ok).toBe('boolean');
    expect(ready.ok).toBe(false);
  });
});
