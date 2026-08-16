import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { apiError } from '../common/api-error';
import type { Trait } from './traits.repository';
import { TraitsRepository } from './traits.repository';

@Injectable()
export class TraitsService {
  constructor(private readonly traits: TraitsRepository) {}

  async list(): Promise<Trait[]> {
    return this.traits.list();
  }

  async create(name: string): Promise<Trait> {
    const normalized = normalize(name);
    const trait = { id: randomUUID(), name: normalized };
    try {
      await this.traits.create(trait);
    } catch (error) {
      if (isUnique(error)) throw apiError(409, 'trait_already_exists', 'A trait with this name already exists.', error);
      throw error;
    }
    return trait;
  }

  async update(id: string, name: string): Promise<void> {
    const normalized = normalize(name);
    try {
      if (!await this.traits.update(id, normalized)) throw apiError(404, 'trait_not_found', 'The trait could not be found.');
    } catch (error) {
      if (isUnique(error)) throw apiError(409, 'trait_already_exists', 'A trait with this name already exists.', error);
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    if (!await this.traits.delete(id)) throw apiError(404, 'trait_not_found', 'The trait could not be found.');
  }

  async addToUser(userId: string, traitId: string): Promise<void> {
    if (!await this.traits.exists(traitId)) throw apiError(404, 'trait_not_found', 'The trait could not be found.');
    await this.traits.addToUser(userId, traitId);
  }

  async removeFromUser(userId: string, traitId: string): Promise<void> {
    await this.traits.removeFromUser(userId, traitId);
  }
}

function normalize(name: string): string {
  const normalized = name.trim();
  if (!normalized || Buffer.byteLength(normalized) > 100) throw apiError(400, 'invalid_trait_request', 'The trait request is invalid.');
  return normalized;
}

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
