import { Injectable, Optional } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { DiscoveryStore } from '../discovery/discovery.store';
import { ScyllaUnavailableError } from '../scylla/scylla.service';
import type { BlockedUser, DataAccessLogRow, DataRequestStatus, DataRequestType, DataSubjectRequestRow, PortableUserData } from './privacy.models';
import { PrivacyRepository } from './privacy.repository';
import { MobileDeliveryService } from '../mobile/mobile-delivery.service';
import { PhotosService } from '../photos/photos.service';

@Injectable()
export class PrivacyService {
  constructor(
    private readonly privacy: PrivacyRepository,
    private readonly discovery: DiscoveryStore,
    private readonly photos: PhotosService,
    @Optional() private readonly delivery?: MobileDeliveryService,
  ) {}

  async createRequest(userId: string, type: DataRequestType): Promise<DataSubjectRequestRow> {
    const request = await this.privacy.createRequest(userId, type);
    if (!request) throw apiError(409, 'data_request_already_open', 'An open request of this type already exists.');
    return request;
  }

  requestsForUser(userId: string): Promise<DataSubjectRequestRow[]> {
    return this.privacy.requestsForUser(userId);
  }

  requestsForAdmin(status: DataRequestStatus | undefined): Promise<DataSubjectRequestRow[]> {
    return this.privacy.requestsForAdmin(status);
  }

  async updateRequest(
    requestId: string,
    status: Exclude<DataRequestStatus, 'pending'>,
    adminId: string,
    adminRole: string,
    notes: string | null,
  ): Promise<'updated' | 'erasure_scheduled'> {
    const result = await this.privacy.updateRequest(requestId, status, adminId, adminRole, notes);
    if (result === 'not_found') throw apiError(404, 'data_request_not_found', 'The data subject request was not found.');
    if (result === 'invalid_transition') throw apiError(409, 'invalid_data_request_transition', 'This data subject request transition is not allowed.');
    return result;
  }

  async exportUserData(userId: string): Promise<PortableUserData> {
    try {
      const [postgresData, outgoingDiscoveryActions] = await Promise.all([
        this.privacy.exportUserData(userId),
        this.discovery.exportOwnActions(userId),
      ]);
      const profile = isRecord(postgresData.profile) ? postgresData.profile : null;
      const photoKey = profile && (typeof profile.photo === 'string' || profile.photo === null) ? profile.photo : null;
      return {
        ...postgresData,
        profile: profile === null ? postgresData.profile : { ...profile, photo: await this.photos.urlForKey(photoKey) },
        discovery_actions: { outgoing: outgoingDiscoveryActions },
      };
    } catch (error) {
      if (error instanceof ScyllaUnavailableError) {
        throw apiError(503, 'data_export_unavailable', 'The complete data export is temporarily unavailable.', error);
      }
      throw error;
    }
  }

  async blockUser(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) throw apiError(400, 'invalid_block_request', 'An account cannot block itself.');
    if (!await this.privacy.blockUser(blockerId, blockedId)) throw apiError(404, 'user_not_found', 'The user to block was not found.');
    await this.delivery?.matchesInvalidated([blockerId, blockedId]);
  }

  async unblockUser(blockerId: string, blockedId: string): Promise<void> {
    await this.privacy.unblockUser(blockerId, blockedId);
    await this.delivery?.matchesInvalidated([blockerId, blockedId]);
  }

  blockedUsers(blockerId: string): Promise<BlockedUser[]> {
    return this.privacy.blockedUsers(blockerId);
  }

  accessLogs(accessedUserId: string): Promise<DataAccessLogRow[]> {
    return this.privacy.accessLogs(accessedUserId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
