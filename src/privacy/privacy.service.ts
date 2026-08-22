import { Injectable, Optional } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { DiscoveryStore } from '../discovery/discovery.store';
import { ScyllaUnavailableError } from '../scylla/scylla.service';
import type { BlockedUser, DataAccessLogRow, DataRequestStatus, DataRequestType, DataSubjectRequestRow, PortableUserData } from './privacy.models';
import { PrivacyRepository } from './privacy.repository';
import { MobileDeliveryService } from '../mobile/mobile-delivery.service';

@Injectable()
export class PrivacyService {
  constructor(
    private readonly privacy: PrivacyRepository,
    private readonly discovery: DiscoveryStore,
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
  ): Promise<void> {
    let result: Awaited<ReturnType<PrivacyRepository['updateRequest']>>;
    try {
      result = await this.privacy.updateRequest(
        requestId,
        status,
        adminId,
        adminRole,
        notes,
        (userId) => this.discovery.deleteUserData(userId),
      );
    } catch (error) {
      if (error instanceof ScyllaUnavailableError) {
        throw apiError(503, 'data_erasure_unavailable', 'Complete account erasure is temporarily unavailable.', error);
      }
      throw error;
    }
    if (result === 'not_found') throw apiError(404, 'data_request_not_found', 'The data subject request was not found.');
    if (result === 'invalid_transition') throw apiError(409, 'invalid_data_request_transition', 'This data subject request transition is not allowed.');
  }

  async exportUserData(userId: string): Promise<PortableUserData> {
    try {
      const [postgresData, outgoingDiscoveryActions] = await Promise.all([
        this.privacy.exportUserData(userId),
        this.discovery.exportOwnActions(userId),
      ]);
      return { ...postgresData, discovery_actions: { outgoing: outgoingDiscoveryActions } };
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
