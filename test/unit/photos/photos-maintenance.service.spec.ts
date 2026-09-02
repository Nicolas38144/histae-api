import { PhotosMaintenanceService } from '../../../src/photos/photos-maintenance.service';

const PHOTO = {
  id: '22222222-2222-4222-8222-222222222222',
  userId: '11111111-1111-4111-8111-111111111111',
  objectKey: 'profile-photos/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.webp',
  status: 'deleting',
};

describe('PhotosMaintenanceService', () => {
  it('deletes claimed objects and completes their database lifecycle', async () => {
    const repository = {
      claimCleanupBatch: jest.fn()
        .mockResolvedValueOnce([PHOTO])
        .mockResolvedValueOnce([]),
      completeDeletion: jest.fn().mockResolvedValue(undefined),
    };
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const service = new PhotosMaintenanceService(
      repository as never,
      storage as never,
      { maintenanceMode: 'disabled' } as never,
    );

    await expect(service.runOnce()).resolves.toEqual({ cleaned: 1, failed: 0 });
    expect(storage.delete).toHaveBeenCalledWith(PHOTO.objectKey);
    expect(repository.completeDeletion).toHaveBeenCalledWith(PHOTO.id);
  });

  it('leaves failed deletions claimed for a later retry', async () => {
    const repository = {
      claimCleanupBatch: jest.fn()
        .mockResolvedValueOnce([PHOTO])
        .mockResolvedValueOnce([]),
      completeDeletion: jest.fn(),
    };
    const storage = { delete: jest.fn().mockRejectedValue(new Error('offline')) };
    const service = new PhotosMaintenanceService(
      repository as never,
      storage as never,
      { maintenanceMode: 'disabled' } as never,
    );

    await expect(service.runOnce()).resolves.toEqual({ cleaned: 0, failed: 1 });
    expect(repository.completeDeletion).not.toHaveBeenCalled();
  });
});
