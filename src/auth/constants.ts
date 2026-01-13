export const jwtConstants = {
  secret: process.env.JWT_SECRET || 'CHANGE_ME',
  accessExpiration: process.env.JWT_EXPIRES_IN || '15m',
};
