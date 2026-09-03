import { Injectable } from '@nestjs/common';
import { NotificationPushRepository } from './notification-push.repository';
import { PushService } from './push.service';

@Injectable()
export class NotificationPushService {
  constructor(private readonly deliveries: NotificationPushRepository, private readonly push: PushService) {}

  async deliver(id: string): Promise<void> {
    const notification = await this.deliveries.findDeliverable(id);
    // Removed, expired, read, revoked or no longer authorized: acknowledge without sending.
    if (!notification) return;
    const payload = notification.payload;
    const data: Record<string, string> = { notification_id: notification.notification_id };
    if (notification.type === 'new_match' || notification.type === 'new_message') data.match_id = payload.match_id!;
    if (notification.type === 'new_message') {
      data.message_id = payload.message_id!;
      data.sender_id = payload.sender_id!;
    }
    await this.push.sendToDevice(notification.token, notification.type, data);
  }
}
