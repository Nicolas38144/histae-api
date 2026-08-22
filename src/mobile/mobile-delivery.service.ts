import { Injectable, Logger } from '@nestjs/common';
import type { PublicMatch, PublicMessage } from '../matches/matches.mapper';
import type { MobileEventType, NotificationType } from './mobile.models';
import { MobileRepository } from './mobile.repository';
import { PushService } from './push.service';
import { RealtimeService } from './realtime.service';

@Injectable()
export class MobileDeliveryService {
  private readonly logger = new Logger(MobileDeliveryService.name);

  constructor(
    private readonly realtime: RealtimeService,
    private readonly mobile: MobileRepository,
    private readonly push: PushService,
  ) {}

  async matchCreated(match: PublicMatch): Promise<void> {
    const data = { match_id: match.id };
    await this.deliver([match.user1_id, match.user2_id], 'match.created', data);
    await Promise.all([
      this.notify(match.user1_id, 'new_match', data),
      this.notify(match.user2_id, 'new_match', data),
    ]);
  }

  async messageCreated(message: PublicMessage, participantIds: [string, string]): Promise<void> {
    const data = { match_id: message.match_id, message_id: message.id, sender_id: message.sender_id };
    await this.deliver(participantIds, 'message.created', data);
    const recipientId = participantIds.find((id) => id !== message.sender_id);
    if (recipientId) await this.notify(recipientId, 'new_message', data);
  }

  async matchUpdated(matchId: string, participantIds: [string, string], data: Record<string, string | number | boolean | null>): Promise<void> {
    await this.deliver(participantIds, 'match.updated', { match_id: matchId, ...data });
  }

  async messagesRead(matchId: string, participantIds: [string, string], readBy: string, readThroughMessageId: string): Promise<void> {
    await this.deliver(participantIds, 'message.read', {
      match_id: matchId,
      read_by: readBy,
      read_through_message_id: readThroughMessageId,
    });
  }

  async matchesInvalidated(userIds: [string, string]): Promise<void> {
    await this.deliver(userIds, 'matches.invalidated', {});
  }

  private async deliver(
    userIds: string[],
    type: MobileEventType,
    data: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    try {
      await this.realtime.emit(userIds, type, data);
    } catch (error) {
      this.logger.warn(`Realtime delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async notify(userId: string, type: NotificationType, data: Record<string, string>): Promise<void> {
    try {
      await this.mobile.createNotification(userId, type, data);
      await this.push.sendToUser(userId, type, data);
    } catch (error) {
      this.logger.warn(`Push notification scheduling failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
