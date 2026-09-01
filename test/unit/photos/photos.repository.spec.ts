import { PhotosRepository } from '../../../src/photos/photos.repository';

describe('PhotosRepository', () => {
  it('locks the profile and persists the transitioned private object key', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ photo: 'profile-photos/old/photo.webp' }] })
        .mockResolvedValueOnce({ rowCount: 1 }),
    };
    const database = {
      transaction: jest.fn(async (work: (transactionClient: typeof client) => Promise<boolean>) => work(client)),
    };
    const repository = new PhotosRepository(database as never);
    const transition = jest.fn().mockResolvedValue('profile-photos/new/photo.webp');

    await expect(repository.withLockedPhoto('user-id', transition)).resolves.toBe(true);

    expect(client.query.mock.calls[0]?.[0]).toContain('FOR UPDATE OF profile');
    expect(transition).toHaveBeenCalledWith('profile-photos/old/photo.webp');
    expect(client.query).toHaveBeenLastCalledWith(
      'UPDATE user_profile SET photo = $2 WHERE user_id = $1',
      ['user-id', 'profile-photos/new/photo.webp'],
    );
  });

  it('does not call storage transition logic when the profile does not exist', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const database = {
      transaction: jest.fn(async (work: (transactionClient: typeof client) => Promise<boolean>) => work(client)),
    };
    const repository = new PhotosRepository(database as never);
    const transition = jest.fn();

    await expect(repository.withLockedPhoto('missing-user', transition)).resolves.toBe(false);
    expect(transition).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
