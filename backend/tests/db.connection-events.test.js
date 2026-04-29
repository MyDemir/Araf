const handlers = {};

jest.mock('mongoose', () => ({
  connection: {
    on: jest.fn((event, cb) => {
      handlers[event] = cb;
    }),
  },
  connect: jest.fn(),
}));

const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();
jest.mock('../scripts/utils/logger', () => ({
  error: (...args) => mockLoggerError(...args),
  info: (...args) => mockLoggerInfo(...args),
}));

const mockUpdateRuntimeState = jest.fn();
const mockMarkDegraded = jest.fn();
const mockClearDegradedIfReady = jest.fn();
jest.mock('../scripts/services/health', () => ({
  updateRuntimeState: (...args) => mockUpdateRuntimeState(...args),
  markDegraded: (...args) => mockMarkDegraded(...args),
  clearDegradedIfReady: (...args) => mockClearDegradedIfReady(...args),
}));

describe('db connection event degraded-mode security scenario', () => {
  beforeEach(() => {
    jest.resetModules();
    Object.keys(handlers).forEach((key) => delete handlers[key]);
    mockLoggerError.mockClear();
    mockLoggerInfo.mockClear();
    mockUpdateRuntimeState.mockClear();
    mockMarkDegraded.mockClear();
    mockClearDegradedIfReady.mockClear();
  });

  test('disconnected handler does not terminate process and marks dbReady=false', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const { registerConnectionHandlers } = require('../scripts/config/db');
    registerConnectionHandlers();

    handlers.disconnected();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockUpdateRuntimeState).toHaveBeenCalledWith({ dbReady: false });
    expect(mockMarkDegraded).toHaveBeenCalledWith(expect.objectContaining({ message: 'MongoDB disconnected' }));

    exitSpy.mockRestore();
  });

  test('connected handler restores runtime db readiness', () => {
    const { registerConnectionHandlers } = require('../scripts/config/db');
    registerConnectionHandlers();

    handlers.connected();

    expect(mockUpdateRuntimeState).toHaveBeenCalledWith({ dbReady: true, lastStartupError: null });
    expect(mockClearDegradedIfReady).toHaveBeenCalled();
  });
});
