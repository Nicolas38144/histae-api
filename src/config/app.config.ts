import * as Joi from 'joi';
import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.APP_PORT || '8000', 10),
  host: process.env.APP_HOST || '0.0.0.0',
  prefix: process.env.APP_PREFIX || 'api',

  postgres: {
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
  },

  scylla: {
    host: process.env.SCYLLA_HOST!,
    keyspace: process.env.SCYLLA_KEYSPACE!,
  },

  redis: {
    host: process.env.REDIS_HOST!,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'supersecret',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  },
}));

export const validationSchema = Joi.object({
  APP_PORT: Joi.number().default(8000),
  APP_HOST: Joi.string().default('0.0.0.0'),
  APP_PREFIX: Joi.string().default('api'),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),

  SCYLLA_HOST: Joi.string().required(),
  SCYLLA_KEYSPACE: Joi.string().required(),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('', null),

  JWT_SECRET: Joi.string().default('supersecret'),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
});
