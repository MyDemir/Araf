const path = require('path');

describe('EventWorker getLogs throughput and 429 resilience', () => {
  let worker;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    const loggerPath = path.resolve(__dirname, '../scripts/utils/logger.js');
    jest.doMock(loggerPath, () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

    const redisPath = path.resolve(__dirname, '../scripts/config/redis.js');
    jest.doMock(redisPath, () => ({ getRedisClient: () => ({ get: jest.fn(), set: jest.fn(), rPush: jest.fn() }) }));

    const tradePath = path.resolve(__dirname, '../scripts/models/Trade.js');
    jest.doMock(tradePath, () => ({ Trade: {}, Listing: {} }));

    const userPath = path.resolve(__dirname, '../scripts/models/User.js');
    jest.doMock(userPath, () => ({}));

    worker = require('../scripts/services/eventListener');
    worker.provider = { getLogs: jest.fn() };
    worker.contract = {
      getAddress: jest.fn().mockResolvedValue('0x000000000000000000000000000000000000dEaD'),
      queryFilter: jest.fn(),
      interface: { parseLog: jest.fn() },
    };
  });

  test('queries a block range with single provider.getLogs call and never uses per-event queryFilter fanout', async () => {
    worker.provider.getLogs.mockResolvedValue([]);

    await worker._queryContractEvents(100, 109, 'replay');

    expect(worker.provider.getLogs).toHaveBeenCalledTimes(1);
    expect(worker.provider.getLogs).toHaveBeenCalledWith({
      address: '0x000000000000000000000000000000000000dEaD',
      fromBlock: 100,
      toBlock: 109,
    });
    expect(worker.contract.queryFilter).not.toHaveBeenCalled();
  });

  test('retries with backoff on 429 throughput errors', async () => {
    worker._sleep = jest.fn().mockResolvedValue(undefined);
    worker.provider.getLogs
      .mockRejectedValueOnce(new Error('code=429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('exceeded its compute units'))
      .mockResolvedValueOnce([]);

    await worker._queryContractEvents(200, 209, 'live');

    expect(worker.provider.getLogs).toHaveBeenCalledTimes(3);
    expect(worker._sleep).toHaveBeenCalledTimes(2);
  });

  test('skips unparseable logs without crashing worker', async () => {
    const rawLogs = [
      { blockNumber: 11, logIndex: 1, transactionHash: '0xbbb', blockHash: '0x2', address: '0xA', topics: [], data: '0x' },
      { blockNumber: 10, logIndex: 3, transactionHash: '0xaaa', blockHash: '0x1', address: '0xA', topics: [], data: '0x' },
    ];
    worker.provider.getLogs.mockResolvedValue(rawLogs);
    worker.contract.interface.parseLog
      .mockImplementationOnce(() => { throw new Error('parse fail'); })
      .mockImplementationOnce(() => ({
        name: 'EscrowReleased',
        args: { tradeId: 7n },
      }));

    const events = await worker._queryContractEvents(10, 11, 'replay');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventName: 'EscrowReleased',
      transactionHash: '0xaaa',
      blockNumber: 10,
      logIndex: 3,
    });
  });
});
