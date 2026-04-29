"use strict";

describe("EventWorker replay batch safety", () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.EVENT_QUERY_BLOCK_RANGE;
  });

  test("stops replay batch and skips all event processing when queryFilter fails", async () => {
    const redisMock = { get: jest.fn().mockResolvedValue(null) };

    jest.doMock("../../config/redis", () => ({
      getRedisClient: () => redisMock,
    }));

    jest.doMock("../../models/Trade", () => ({
      Trade: {},
      Listing: {},
    }));

    jest.doMock("../../models/User", () => ({}));

    const warn = jest.fn();
    const info = jest.fn();
    const error = jest.fn();
    const debug = jest.fn();
    jest.doMock("../../utils/logger", () => ({ warn, info, error, debug }));

    const worker = require("../eventListener");

    worker._resolveReplayStartBlock = jest.fn().mockReturnValue(1);
    worker.provider = { getBlockNumber: jest.fn().mockResolvedValue(25) };

    const okEvent = {
      eventName: "WalletRegistered",
      blockNumber: 5,
      logIndex: 0,
      args: {},
    };

    worker.contract = {
      queryFilter: jest.fn(async (eventName, from, to) => {
        if (from === 1 && to === 10 && eventName === "WalletRegistered") return [okEvent];
        if (from === 1 && to === 10 && eventName === "EscrowCreated") throw new Error("provider limit");
        return [];
      }),
    };

    worker._processEvent = jest.fn();
    worker._updateSafeCheckpointIfHigher = jest.fn();

    await worker._replayMissedEvents();

    expect(worker._processEvent).not.toHaveBeenCalled();
    expect(worker._updateSafeCheckpointIfHigher).not.toHaveBeenCalled();
    expect(worker.contract.queryFilter).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });
});
