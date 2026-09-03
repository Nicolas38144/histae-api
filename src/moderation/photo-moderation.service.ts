import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { AutomatedPhotoModeration, ModerationReasonCode } from './moderation.models';

export const PHOTO_MODERATION_POLICY_VERSION = 'local_vision_v1';

type AnalysisResponse = {
  face_count: number;
  sharpness_score: number;
  nsfw_score: number;
};

@Injectable()
export class PhotoModerationService {
  private readonly logger = new Logger(PhotoModerationService.name);

  constructor(private readonly config: ConfigService) {}

  async analyze(webp: Buffer): Promise<AutomatedPhotoModeration> {
    if (this.config.photoModeration.provider === 'disabled') return unavailableDecision();
    try {
      const response = await fetch(new URL('v1/analyze', this.config.photoModeration.endpoint), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.photoModeration.token}`,
          'content-type': 'image/webp',
          'content-length': String(webp.length),
        },
        body: new Uint8Array(webp),
        signal: AbortSignal.timeout(this.config.photoModeration.timeoutMillis),
      });
      if (!response.ok) throw new Error(`photo moderation returned ${response.status}`);
      const analysis = parseAnalysis(await response.json());
      const reasonCodes: ModerationReasonCode[] = [];
      if (analysis.face_count === 0) reasonCodes.push('face_not_detected');
      if (analysis.face_count > 1) reasonCodes.push('multiple_faces');
      if (analysis.sharpness_score < this.config.photoModeration.minSharpnessScore) reasonCodes.push('blurry');
      if (analysis.nsfw_score >= this.config.photoModeration.nsfwReviewThreshold) reasonCodes.push('explicit_image');
      return {
        status: reasonCodes.length === 0 ? 'approved' : 'pending',
        reasonCodes,
        policyVersion: PHOTO_MODERATION_POLICY_VERSION,
        faceCount: analysis.face_count,
        sharpnessScore: analysis.sharpness_score,
        nsfwScore: analysis.nsfw_score,
      };
    } catch {
      this.logger.warn('Photo moderation analysis failed; manual review required');
      return unavailableDecision();
    }
  }
}

function parseAnalysis(value: unknown): AnalysisResponse {
  if (typeof value !== 'object' || value === null) throw new Error('invalid response');
  const faceCount = 'face_count' in value ? value.face_count : undefined;
  const sharpnessScore = 'sharpness_score' in value ? value.sharpness_score : undefined;
  const nsfwScore = 'nsfw_score' in value ? value.nsfw_score : undefined;
  if (!Number.isInteger(faceCount) || (faceCount as number) < 0 || (faceCount as number) > 100
    || typeof sharpnessScore !== 'number' || !Number.isFinite(sharpnessScore) || sharpnessScore < 0
    || typeof nsfwScore !== 'number' || !Number.isFinite(nsfwScore) || nsfwScore < 0 || nsfwScore > 1) {
    throw new Error('invalid response');
  }
  return { face_count: faceCount as number, sharpness_score: sharpnessScore, nsfw_score: nsfwScore };
}

function unavailableDecision(): AutomatedPhotoModeration {
  return {
    status: 'pending',
    reasonCodes: ['analysis_unavailable'],
    policyVersion: PHOTO_MODERATION_POLICY_VERSION,
    faceCount: null,
    sharpnessScore: null,
    nsfwScore: null,
  };
}
