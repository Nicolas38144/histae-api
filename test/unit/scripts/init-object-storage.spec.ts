import { ensureBucket } from '../../../scripts/init-object-storage';

describe('S3 bucket initialization', () => {
  it('does not mutate an existing bucket', async () => {
    const send = jest.fn().mockResolvedValue({});
    await ensureBucket({ send } as never, 'photos');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('creates an absent bucket and verifies it', async () => {
    const send = jest.fn().mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockResolvedValue({});
    await ensureBucket({ send } as never, 'photos');
    expect(send.mock.calls.map(([command]) => command.constructor.name))
      .toEqual(['HeadBucketCommand', 'CreateBucketCommand', 'HeadBucketCommand']);
  });

  it('refuses to treat an authentication failure as an absent bucket', async () => {
    const error = Object.assign(new Error(), { name: 'Forbidden' });
    const send = jest.fn().mockRejectedValue(error);
    await expect(ensureBucket({ send } as never, 'photos')).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('allows a concurrent creation owned by the same account', async () => {
    const send = jest.fn().mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'BucketAlreadyOwnedByYou' }))
      .mockResolvedValue({});
    await ensureBucket({ send } as never, 'photos');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('refuses a bucket name already owned by another account', async () => {
    const error = Object.assign(new Error(), { name: 'BucketAlreadyExists' });
    const send = jest.fn().mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockRejectedValueOnce(error);
    await expect(ensureBucket({ send } as never, 'photos')).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
