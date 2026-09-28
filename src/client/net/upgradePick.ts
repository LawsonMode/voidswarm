// Level-up picks: one chooseUpgrade per offer. Pure, unit-tested.
// The HUD's offer only changes when a snapshot arrives (50 ms + RTT online), so a double-click or a
// quick 1-then-2 would otherwise send two picks and the second would land on the NEXT queued offer
// (possibly the irreversible path fork) that the player never saw. The server also ignores a pick whose
// offerId is stale; this guard keeps the client from sending one at all.
import type { ClientMsg } from '../../shared/protocol';
import type { YouState } from '../../shared/types';

/** After this long without a new offer, allow re-sending for the same offer (lost / refused pick). */
export const PICK_RETRY_MS = 1500;
/**
 * After a pick, the NEXT offer's cards ignore input for this long. Offline the next queued offer
 * appears within one frame, so without this a double-tap spends it on cards the player never read.
 */
export const NEXT_OFFER_ARM_MS = 350;

export class UpgradePickGuard {
  private sentKey: string | null = null;
  private sentAt = 0;
  /** Index picked for the offer currently on screen (for card feedback), or -1. */
  pickedIndex = -1;

  reset(): void { this.sentKey = null; this.sentAt = 0; this.pickedIndex = -1; }

  /** The chooseUpgrade message to send for card `index`, or null (no offer / bad index / already picked). */
  pick(you: YouState | null | undefined, index: number, nowMs: number): Extract<ClientMsg, { type: 'chooseUpgrade' }> | null {
    const offer = you?.offer;
    if (!you || !offer || !Number.isInteger(index) || index < 0 || index >= offer.length) return null;
    const key = offerKey(you);
    if (key === this.sentKey && nowMs - this.sentAt < PICK_RETRY_MS) return null;
    if (this.sentKey !== null && key !== this.sentKey && nowMs - this.sentAt < NEXT_OFFER_ARM_MS) return null;
    this.sentKey = key;
    this.sentAt = nowMs;
    this.pickedIndex = index;
    return { type: 'chooseUpgrade', index, offerId: you.offerId };
  }

  /** Index already picked for this exact offer (still showing until the next snapshot), else -1. */
  pickedFor(you: YouState | null | undefined): number {
    return you?.offer && this.sentKey !== null && offerKey(you) === this.sentKey ? this.pickedIndex : -1;
  }
}

function offerKey(you: YouState): string {
  const cards = (you.offer ?? []).map((o) => `${o.id}:${o.level}`).join('|');
  return `${you.shipId}#${you.offerId ?? ''}#${cards}`;
}
