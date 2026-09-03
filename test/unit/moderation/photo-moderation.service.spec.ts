import { PhotoModerationService } from '../../../src/moderation/photo-moderation.service';

describe('PhotoModerationService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('approves only a sharp, single-face and low-risk analysis', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      face_count: 1,
      sharpness_score: 125.5,
      nsfw_score: 0.02,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new PhotoModerationService(config() as never);

    await expect(service.analyze(Buffer.from('webp'))).resolves.toEqual({
      status: 'approved',
      reasonCodes: [],
      policyVersion: 'local_vision_v1',
      faceCount: 1,
      sharpnessScore: 125.5,
      nsfwScore: 0.02,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8090/v1/analyze'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps flagged and unavailable analyses pending for a human', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      face_count: 0,
      sharpness_score: 20,
      nsfw_score: 0.9,
    }), { status: 200 }));
    const service = new PhotoModerationService(config() as never);
    await expect(service.analyze(Buffer.from('webp'))).resolves.toEqual(expect.objectContaining({
      status: 'pending',
      reasonCodes: ['face_not_detected', 'blurry', 'explicit_image'],
    }));

    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('offline'));
    await expect(service.analyze(Buffer.from('webp'))).resolves.toEqual(expect.objectContaining({
      status: 'pending',
      reasonCodes: ['analysis_unavailable'],
      faceCount: null,
    }));
  });

  it('does not call the network while the provider is disabled', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const service = new PhotoModerationService(config('disabled') as never);
    await expect(service.analyze(Buffer.from('webp'))).resolves.toEqual(expect.objectContaining({
      status: 'pending', reasonCodes: ['analysis_unavailable'],
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function config(provider: 'disabled' | 'local_http' = 'local_http') {
  return { photoModeration: {
    provider,
    endpoint: 'http://127.0.0.1:8090/',
    token: 't'.repeat(32),
    timeoutMillis: 5_000,
    minSharpnessScore: 80,
    nsfwReviewThreshold: 0.7,
  } };
}
