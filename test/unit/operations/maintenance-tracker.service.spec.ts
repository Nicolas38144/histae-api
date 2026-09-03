import { MaintenanceTrackerService } from '../../../src/operations/maintenance-tracker.service';

describe('MaintenanceTrackerService', () => {
  it('records a successful run and its processed count', async () => {
    const repository = { start: jest.fn(), finish: jest.fn() };
    const tracker = new MaintenanceTrackerService(repository as never);

    await expect(tracker.track('photos', async () => ({ cleaned: 2 }), (result) => result.cleaned))
      .resolves.toEqual({ cleaned: 2 });

    expect(repository.start).toHaveBeenCalledWith('photos', expect.any(String), expect.any(Date));
    expect(repository.finish).toHaveBeenCalledWith(expect.objectContaining({
      jobName: 'photos', status: 'succeeded', processedCount: 2, errorCode: null,
    }));
  });

  it('records skipped leadership and normalizes a failed run', async () => {
    const repository = { start: jest.fn(), finish: jest.fn() };
    const tracker = new MaintenanceTrackerService(repository as never);

    await expect(tracker.track('privacy', async () => undefined, () => 0)).resolves.toBeUndefined();
    await expect(tracker.track('matches', async () => { throw new Error('private database detail'); }, () => 0))
      .rejects.toThrow('private database detail');

    expect(repository.finish).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'skipped' }));
    expect(repository.finish).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'failed', errorCode: 'maintenance_execution_failed',
    }));
  });

  it('does not break business maintenance when status persistence is unavailable', async () => {
    const repository = {
      start: jest.fn().mockRejectedValue(new Error('offline')),
      finish: jest.fn().mockRejectedValue(new Error('offline')),
    };
    const tracker = new MaintenanceTrackerService(repository as never);
    await expect(tracker.track('outbox', async () => 3, (result) => result)).resolves.toBe(3);
  });
});
