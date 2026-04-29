const { getReadiness, updateRuntimeState, markDegraded } = require('../scripts/services/health');

describe('readiness degraded mode security scenario', () => {
  test('returns ok=false when runtime degraded=true', async () => {
    updateRuntimeState({ serverListening: true, dbReady: true, redisReady: true, protocolConfigReady: true, workerReady: true, degraded: true });
    const ready = await getReadiness();
    expect(ready.ok).toBe(false);
  });

  test('includes runtime state and last errors in response', async () => {
    updateRuntimeState({ serverListening: true, dbReady: false, redisReady: false, protocolConfigReady: false, workerReady: false, degraded: false, lastStartupError: null, lastWorkerError: null });
    markDegraded(new Error('startup_fail'));
    markDegraded(new Error('worker_fail'), { worker: true });
    const ready = await getReadiness();
    expect(ready.runtime).toBeDefined();
    expect(ready.runtime).toHaveProperty('serverListening');
    expect(ready.runtime).toHaveProperty('lastStartupError');
    expect(ready.runtime).toHaveProperty('lastWorkerError');
    expect(ready.runtime.lastStartupError.message).toContain('startup_fail');
    expect(ready.runtime.lastWorkerError.message).toContain('worker_fail');
  });
});
