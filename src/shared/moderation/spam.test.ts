import { describe, expect, it } from 'vitest';
import {
  CAPS_MIN_LEN, FLOOD_KEEP, SPAM_REPEAT_COUNT, SPAM_REPEAT_MS, collapseFlood, isShouting, isSpam, spamKey, tameText,
  type RecentLine,
} from './spam';

/** The Zone's usage: push every accepted line, never a refused one. */
function chat(lines: readonly [string, number][], text: string, now: number): boolean {
  const recent: RecentLine[] = lines.map(([t, time]) => ({ text: t, time }));
  return isSpam(recent, text, now);
}

describe('isSpam (repeat flood)', () => {
  it('refuses the third identical line inside the window', () => {
    expect(chat([], 'hi', 1000)).toBe(false);
    expect(chat([['hi', 1000]], 'hi', 2000)).toBe(false);
    expect(chat([['hi', 1000], ['hi', 2000]], 'hi', 3000)).toBe(true);
    expect(SPAM_REPEAT_COUNT).toBe(3);
  });

  it('only counts copies inside the window', () => {
    const old = 100_000;
    expect(chat([['hi', old], ['hi', old + 1000]], 'hi', old + 1000 + SPAM_REPEAT_MS + 1)).toBe(false);
    expect(chat([['hi', old], ['hi', old + 1000]], 'hi', old + SPAM_REPEAT_MS - 1)).toBe(true); // both still inside
  });

  it('sees through case, spacing, punctuation and character floods', () => {
    const rec: [string, number][] = [['gg ez', 1000], ['GG!!! ez', 2000]];
    expect(chat(rec, 'g g   e z', 3000)).toBe(true);
    expect(chat(rec, 'ggggggg ez', 3000)).toBe(true);
    expect(chat(rec, '...GG,,, EZ...', 3000)).toBe(true);
  });

  it('lets different lines through, however fast', () => {
    const rec: [string, number][] = [['one', 1000], ['two', 1100]];
    expect(chat(rec, 'three', 1200)).toBe(false);
    expect(chat([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]], 'f', 6)).toBe(false);
  });

  it('is total: junk recent entries, empty text and clock skew never throw', () => {
    expect(isSpam(null, 'hi', 1000)).toBe(false);
    expect(isSpam(undefined, 'hi', 1000)).toBe(false);
    expect(isSpam([], 'hi', 1000)).toBe(false);
    expect(isSpam([{ text: 'hi', time: 5000 }, { text: 'hi', time: 5000 }], 'hi', 1000)).toBe(false); // future lines
    expect(isSpam([null as unknown as RecentLine, { text: 'hi', time: 1 }], 'hi', 2)).toBe(false);
    expect(chat([['', 1000], ['', 1100]], '', 1200)).toBe(false);
    expect(chat([['   ', 1000], ['!!!', 1100]], '???', 1200)).toBe(false);
  });

  it('spamKey ignores decoration but keeps different messages apart', () => {
    expect(spamKey('GG!!!')).toBe(spamKey('g g'));
    expect(spamKey('nice shot')).not.toBe(spamKey('nice try'));
    expect(spamKey('\u{1F600}\u{1F600}')).toBeTruthy();
  });
});

describe('caps and character floods (display)', () => {
  it('lowercases shouting over CAPS_MIN_LEN characters', () => {
    const shout = 'EVERYONE GET TO THE FLAG';
    expect(isShouting(shout)).toBe(true);
    expect(tameText(shout)).toBe(shout.toLowerCase());
    expect(tameText('GG')).toBe('GG'); // short lines may shout
    expect(isShouting('OK')).toBe(false);
    expect('HELP ME NOW!!'.length).toBeGreaterThan(CAPS_MIN_LEN);
    expect(tameText('I am going to the BASE now')).toBe('I am going to the BASE now'); // under the ratio
    expect(tameText('MOSTLY caps HERE and THERE ok')).toBe('MOSTLY caps HERE and THERE ok');
  });

  it('collapses character and unit floods, leaving ordinary text and numbers alone', () => {
    expect(collapseFlood('a'.repeat(50))).toBe('a'.repeat(FLOOD_KEEP));
    expect(collapseFlood('hiiiiiiii')).toBe('hiii');
    expect(collapseFlood('hahahahahaha')).toBe('hahaha'); // the repeated unit is kept FLOOD_KEEP times
    expect(collapseFlood('lolololololol')).toBe('lololol'); // ...and the odd trailing character stays
    expect(collapseFlood('hello there')).toBe('hello there');
    expect(collapseFlood('1000000 points')).toBe('1000000 points');
    expect(collapseFlood('')).toBe('');
    expect(collapseFlood('\u{1F600}'.repeat(20))).toBe('\u{1F600}'.repeat(FLOOD_KEEP));
  });

  it('tameText leaves links exactly as typed and tames only the text around them', () => {
    expect(tameText('https://aaaa.example.com/xxxxxxx')).toBe('https://aaaa.example.com/xxxxxxx');
    expect(tameText('see www.Example.com/AAAAAAA ok')).toBe('see www.Example.com/AAAAAAA ok');
    expect(tameText('WOOOOOOOW LOOK AT THIS https://x.test/ABCDEF')).toBe('wooow look at this https://x.test/ABCDEF');
    expect(tameText('niceeeeeee http://a.test/B then byeeeeee')).toBe('niceee http://a.test/B then byeee');
  });

  it('tameText is idempotent and total', () => {
    const messy = 'AAAAAAAAAAAAAAAA HELP!!!!!!!!';
    const once = tameText(messy);
    expect(tameText(once)).toBe(once);
    expect(tameText('')).toBe('');
    expect(tameText(undefined as unknown as string)).toBe('');
  });

  it('is linear: a 4000-character flood is instant', () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) tameText('ab'.repeat(2000));
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
