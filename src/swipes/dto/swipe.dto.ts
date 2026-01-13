export class SwipeDto {
  targetUserId: string;
  action: 'like' | 'dislike' | 'superlike';
}
