import { Injectable } from '@nestjs/common';
import type { AutomatedModerationDecision, ModerationReasonCode } from './moderation.models';

export const TEXT_MODERATION_POLICY_VERSION = 'text_rules_v1';

const INSULTS = new Set([
  'abruti', 'abrutie', 'connard', 'connasse', 'conne', 'cretin', 'cretine',
  'debile', 'idiot', 'idiote', 'imbecile', 'merde', 'salope', 'pute',
  'asshole', 'bastard', 'bitch', 'idiot', 'moron', 'slut', 'whore',
]);

const SEXUAL_TERMS = new Set([
  'baise', 'baiser', 'bite', 'chatte', 'cul', 'escort', 'nude', 'nudes',
  'onlyfans', 'porn', 'porno', 'pornographie', 'sexe', 'sexcam', 'sugarbaby',
]);

const SPAM_TERMS = new Set([
  'bitcoin', 'casino', 'crypto', 'cryptomonnaie', 'dropshipping', 'investissement',
  'promotion', 'promo', 'telegram', 'whatsapp', 'snapchat', 'onlyfans',
]);

@Injectable()
export class TextModerationService {
  analyze(value: string): AutomatedModerationDecision {
    const normalized = normalizeForRules(value);
    const words = normalized.match(/[a-z0-9]+/g) ?? [];
    const wordSet = new Set(words);
    const reasonCodes: ModerationReasonCode[] = [];

    if (looksLikeSpam(normalized, words, wordSet)) reasonCodes.push('spam');
    if (containsAny(wordSet, INSULTS)) reasonCodes.push('insult');
    if (containsPersonalContact(normalized)) reasonCodes.push('personal_contact');
    if (containsAny(wordSet, SEXUAL_TERMS)) reasonCodes.push('sexual_content');

    return {
      status: reasonCodes.length === 0 ? 'approved' : 'pending',
      reasonCodes,
      policyVersion: TEXT_MODERATION_POLICY_VERSION,
    };
  }
}

function normalizeForRules(value: string): string {
  return value.normalize('NFKD').replace(/\p{Mark}/gu, '').toLowerCase();
}

function containsAny(words: Set<string>, candidates: Set<string>): boolean {
  return [...candidates].some((candidate) => words.has(candidate));
}

function looksLikeSpam(value: string, words: string[], wordSet: Set<string>): boolean {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return /(.)\1{7,}/u.test(value)
    || [...counts.values()].some((count) => count >= 5)
    || containsAny(wordSet, SPAM_TERMS) && /(?:contact|dm|ajoute|rejoins|gagne|gratuit|promo)/u.test(value);
}

function containsPersonalContact(value: string): boolean {
  const email = /\b[a-z0-9._%+-]+\s*(?:@|\bat\b)\s*[a-z0-9.-]+\.[a-z]{2,}\b/u;
  const url = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|fr|net|org|io)\b)/u;
  const socialHandle = /(?:^|\s)@[a-z0-9._-]{3,32}\b/u;
  const phone = /(?:\+?\d[\s().-]*){8,}/u;
  return email.test(value) || url.test(value) || socialHandle.test(value) || phone.test(value);
}
