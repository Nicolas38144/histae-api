import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * JWT Guard placeholder
 * You can implement actual JWT validation logic here
 */
@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    // attach a dummy user for testing
    req.user = { id: '00000000-0000-0000-0000-000000000000' };
    return true;
  }
}
