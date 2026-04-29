const fs = require('fs');
const path = require('path');

describe('EventWorker polling and production guard hardening', () => {
  let worker;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    process.env.EVENT_POLL_INTERVAL_MS = '60000';
    process.env.EVENT_CONFIRMATIONS = '2';
    delete process.env.EVENT_QUERY_BLOCK_RANGE;
    delete process.env.GET_LOGS_MAX_RETRIES;

    const loggerPath = path.resolve(__dirname, '../scripts/utils/logger.js');
    jest.doMock(loggerPath, () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

    const redisPath = path.resolve(__dirname, '../scripts/config/redis.js');
    jest.doMock(redisPath, () => ({ getRedisClient: () => ({ get: jest.fn(), set: jest.fn(), rPush: jest.fn() }) }));

    const tradePath = path.resolve(__dirname, '../scripts/models/Trade.js');
    jest.doMock(tradePath, () => ({ Trade: {}, Listing: {} }));
    const userPath = path.resolve(__dirname, '../scripts/models/User.js');
    jest.doMock(userPath, () => ({}));

    worker = require('../scripts/services/eventListener');
  });

  test('does not use provider.on("block") in event listener live flow', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../scripts/services/eventListener.js'), 'utf8');
    expect(source.includes('provider.on("block"')).toBe(false);
  });

  test('starts interval polling with EVENT_POLL_INTERVAL_MS=60000 and skips overlapping cycles', async () => {
    jest.useFakeTimers();
    const runSpy = jest.spyOn(worker, '_runLivePollCycle').mockResolvedValue(undefined);
    worker._startLivePolling();

    jest.advanceTimersByTime(60000);
    await Promise.resolve();
    expect(runSpy).toHaveBeenCalledTimes(1);

    worker._livePollInProgress = true;
    const pollRangeSpy = jest.spyOn(worker, '_pollLiveRange').mockResolvedValue(undefined);
    worker.provider = { getBlockNumber: jest.fn().mockResolvedValue(100) };
    await worker._runLivePollCycle();
    expect(pollRangeSpy).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('polls confirmed safe range and advances cursor', async () => {
    worker.provider = { getBlockNumber: jest.fn().mockResolvedValue(100) };
    worker._lastLivePolledBlock = 90;
    worker._pollLiveRange = jest.fn().mockResolvedValue(undefined);
    worker._advanceSafeCheckpointFromAcks = jest.fn().mockResolvedValue(undefined);
    await worker._runLivePollCycle();
    expect(worker._pollLiveRange).toHaveBeenCalledWith(91, 98);
    expect(worker._lastLivePolledBlock).toBe(98);
  });

  test('fails in production when replay start block is zero without checkpoint', () => {
    process.env.ARAF_DEPLOYMENT_BLOCK = '0';
    expect(() => worker._resolveReplayStartBlock(null, 100)).toThrow(/KRİTİK/);
  });


  test('start keeps development dry-run by skipping live bootstrap when provider/contract missing', async () => {
    process.env.NODE_ENV = 'development';
    worker._connect = jest.fn().mockResolvedValue(undefined);
    worker._replayMissedEvents = jest.fn().mockResolvedValue(undefined);
    worker.provider = null;
    worker.contract = null;
    const getCurrentSpy = jest.spyOn(worker, '_getCurrentBlock');
    const startPollingSpy = jest.spyOn(worker, '_startLivePolling');

    await worker.start();

    expect(getCurrentSpy).not.toHaveBeenCalled();
    expect(startPollingSpy).not.toHaveBeenCalled();
    expect(worker.isRunning).toBe(true);
  });

  test('reconnect skips live bootstrap when provider/contract missing after reconnect', async () => {
    jest.useFakeTimers();
    worker.provider = { removeAllListeners: jest.fn(), destroy: jest.fn().mockResolvedValue(undefined) };
    worker._connect = jest.fn().mockImplementation(() => { worker.provider = null; worker.contract = null; });
    worker._replayMissedEvents = jest.fn().mockResolvedValue(undefined);
    const startPollingSpy = jest.spyOn(worker, '_startLivePolling');
    const getCurrentSpy = jest.spyOn(worker, '_getCurrentBlock');
    worker._sleep = jest.fn().mockResolvedValue(undefined);

    const reconnectPromise = worker._reconnect();
    await jest.advanceTimersByTimeAsync(5000);
    await reconnectPromise;

    expect(startPollingSpy).not.toHaveBeenCalled();
    expect(getCurrentSpy).not.toHaveBeenCalledWith('reconnect-bootstrap');
    jest.useRealTimers();
  });

  test('runLivePollCycle preserves checkpoint-interval replay safety', async () => {
    worker.provider = { getBlockNumber: jest.fn().mockResolvedValue(100) };
    worker._lastLivePolledBlock = 90;
    worker._lastSafeCheckpointBlock = 40;
    worker._pollLiveRange = jest.fn().mockResolvedValue(undefined);
    worker._advanceSafeCheckpointFromAcks = jest.fn().mockResolvedValue(undefined);
    worker._replayMissedEvents = jest.fn().mockResolvedValue(undefined);

    await worker._runLivePollCycle();

    expect(worker._replayMissedEvents).toHaveBeenCalledTimes(1);
  });

  test('uses production default query block range 500 and env override for GET_LOGS_MAX_RETRIES', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../scripts/services/eventListener.js'), 'utf8');
    expect(source).toContain('DEFAULT_EVENT_QUERY_BLOCK_RANGE_PROD = 500');
    expect(source).toContain('DEFAULT_EVENT_QUERY_BLOCK_RANGE_DEV = 10');
    expect(source).toContain('GET_LOGS_MAX_RETRIES = _readPositiveIntEnv("GET_LOGS_MAX_RETRIES", GET_LOGS_MAX_RETRIES_PROD, GET_LOGS_MAX_RETRIES_DEV)');
  });
});
