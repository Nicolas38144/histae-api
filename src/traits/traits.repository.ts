import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type Trait = { id: string; name: string };

@Injectable()
export class TraitsRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(): Promise<Trait[]> {
    return (await this.database.query<Trait>('SELECT id, name FROM trait ORDER BY name, id')).rows;
  }

  async create(trait: Trait): Promise<void> {
    await this.database.query('INSERT INTO trait (id, name) VALUES ($1, $2)', [trait.id, trait.name]);
  }

  async update(id: string, name: string): Promise<boolean> {
    return (await this.database.query('UPDATE trait SET name = $2 WHERE id = $1', [id, name])).rowCount === 1;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.database.query('DELETE FROM trait WHERE id = $1', [id])).rowCount === 1;
  }

  async exists(id: string): Promise<boolean> {
    return !!(await this.database.query<{ id: string }>('SELECT id FROM trait WHERE id = $1', [id])).rows[0];
  }

  async addToUser(userId: string, traitId: string): Promise<void> {
    await this.database.query('INSERT INTO user_trait (user_id, trait_id) VALUES ($1, $2) ON CONFLICT (user_id, trait_id) DO NOTHING', [userId, traitId]);
  }

  async removeFromUser(userId: string, traitId: string): Promise<void> {
    await this.database.query('DELETE FROM user_trait WHERE user_id = $1 AND trait_id = $2', [userId, traitId]);
  }
}
