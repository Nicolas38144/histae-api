import { Injectable, Logger } from '@nestjs/common';
import type { PublicMatch, PublicMessage } from '../matches/matches.mapper';
import type { MobileEventType } from './mobile.models';
import { RealtimeService } from './realtime.service';

@Injectable()
export class MobileDeliveryService {
  private readonly logger = new Logger(MobileDeliveryService.name);

  constructor(private readonly realtime: RealtimeService) {}

  async matchCreated(match: PublicMatch): Promise<void> {
    const data = { match_id: match.id };
    await this.deliver([match.user1_id, match.user2_id], 'match.created', data);
  }

  async messageCreated(message: PublicMessage, participantIds: [string, string]): Promise<void> {
    const data = { match_id: message.match_id, message_id: message.id, sender_id: message.sender_id };
    await this.deliver(participantIds, 'message.created', data);
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

  async subscriptionUpdated(userId: string, status: string): Promise<void> {
    await this.deliver([userId], 'subscription.updated', { status });
  }

  private async deliver(
    userIds: string[],
    type: MobileEventType,
    data: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    try {
      await this.realtime.emit(userIds, type, data);
    } catch {
      this.logger.warn('realtime_delivery_failed');
    }
  }
}
