// OWNER: FILTER agent. Word-list DATA for the chat / name filter (src/shared/moderation). Pure data, no logic
// beyond the ROT13 decoder.
//
// Why ROT13: every blocked / masked term below is stored ROT13-encoded ("shpx" = the 4-letter f-word) so slurs
// don't turn up in a casual grep, a code search or a screen-share of the repo. It is NOT security — the terms are
// decoded once, lazily, the first time the filter runs (see engine.ts). To add a term: ROT13 it (letters shift by
// 13, anything else is kept), lowercase ASCII letters and single spaces only, and put it in the right group.
// Leetspeak, look-alike letters, repeats, spacing and common suffixes are handled by the normalizer, so list only
// the plain spelling (plus spelling variants the normalizer can't derive, e.g. "phuck").
//
// The allowlist, suffixes and short words further down are ordinary clean words, stored in plain text.

/**
 * block = the whole line is withheld (slurs, hate, sexual content, threats, self-harm statements);
 * mask  = profanity: shown with the word starred out;
 * mild  = masked in 'strict' (the classroom default), shown as typed in 'standard'.
 */
export type Tier = 'block' | 'mask' | 'mild';
export type Category = 'slur' | 'hate' | 'sexual' | 'threat' | 'selfharm' | 'profanity' | 'mild';
/**
 * How a term may match (every mode is case / leet / look-alike / repeat-insensitive and may be split by
 * punctuation, e.g. "f.u.c.k"; "boundary" = start or end of a word, where a camelCase hump counts as one):
 *  - strong:   anywhere, even inside another word ("xfuckx"); split across spaces only boundary to boundary
 *              ("f u c k", "fu ck"). Only for terms no clean English word contains (the allowlist rescues the
 *              rest, e.g. "Scunthorpe").
 *  - compound: like strong, but across spaces only when spelled out in tiny pieces (the parts are clean words).
 *  - word:     boundary to boundary, plus a common suffix (-s, -es, -ed, -er, -ing, -y, ...). Split across
 *              spaces only when the pieces are tiny ("a s s", "sh it"), never from two real words ("pen is").
 *  - exact:    like word, but no suffix (abbreviations: "kys").
 *  - phrase:   several words, boundary to boundary, however they are spaced ("kill yourself", "killyourself").
 */
export type MatchMode = 'strong' | 'compound' | 'word' | 'exact' | 'phrase';

export interface TermGroup {
  tier: Tier;
  category: Category;
  mode: MatchMode;
  /** ROT13-encoded terms (see the header). */
  terms: readonly string[];
}

/** Decode one ROT13 entry. */
export function rot13(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) out += String.fromCharCode(((c - 97 + 13) % 26) + 97);
    else if (c >= 65 && c <= 90) out += String.fromCharCode(((c - 65 + 13) % 26) + 65);
    else out += s[i];
  }
  return out;
}

/** Chat AND names. */
export const TERM_GROUPS: readonly TermGroup[] = [
  { tier: 'block', category: 'slur', mode: 'strong', terms: [
    'avttre', 'avttn', 'avttnu', 'avtthu', 'avttnm', 'avtthe', 'avtyrg', 'avddn', 'avddre', 'snttbg', 'snttvg',
    'snttrg', 'furznyr', 'jrgonpx', 'wvtnobb', 'tbyyvjbt', 'yvogneq', 'phag',
  ] },
  { tier: 'block', category: 'slur', mode: 'word', terms: [
    'arteb', 'pbba', 'fcvp', 'fcvpx', 'xvxr', 'xlxr', 'puvax', 'tbbx', 'wnc', 'cnxv', 'jbt', 'qntb', 'jbc', 'ubaxl',
    'erqfxva', 'vawha', 'fdhnj', 'urro', 'ulzvr', 'ornare', 'jvttre', 'jvttn', 'fnzob', 'qnexvr', 'qnexl', 'snt',
    'sntbg', 'qlxr', 'genaal', 'genaavr', 'yrfob', 'ubzb', 'ergneq', 'gneq', 'avoon', 'xhag', 'zbatbybvq',
  ] },
  { tier: 'block', category: 'slur', mode: 'phrase', terms: [
    'whatyr ohaal', 'cbepu zbaxrl', 'fcrne puhpxre', 'pnzry wbpxrl', 'ent urnq', 'gbjry urnq', 'mvccre urnq',
    'fynag rlr', 'avt abt',
  ] },
  { tier: 'block', category: 'hate', mode: 'exact', terms: [
    'wrjrq',
  ] },
  { tier: 'block', category: 'hate', mode: 'phrase', terms: [
    'urvy uvgyre', 'fvrt urvy', 'tnf gur wrjf', 'xvyy nyy wrjf', 'xvyy gur wrjf', 'xvyy nyy oynpxf', 'xvyy nyy tnlf',
    'xvyy nyy zhfyvzf', 'xvyy nyy zrkvpnaf', 'uvgyre qvq abguvat jebat', 'uvgyre jnf evtug', 'tb onpx gb lbhe pbhagel',
    'tb onpx gb nsevpn', 'tb onpx gb zrkvpb', 'tb onpx gb puvan',
  ] },
  { tier: 'block', category: 'sexual', mode: 'strong', terms: [
    'cbea', 'oybjwbo', 'evzwbo', 'phzfubg', 'phzfyhg', 'ohxxnxr', 'phaavyvathf', 'sryyngvb', 'znfgheong', 'qvyqb',
    'uragnv', 'wvmm', 'betnfz', 'pbpxfhpxre', 'pyvgbevf', 'crqbcuvy', 'cnrqbcuvy', 'zbyrfg', 'vaprfg', 'orfgvnyvgl',
  ] },
  { tier: 'block', category: 'sexual', mode: 'compound', terms: [
    'unaqwbo', 'sbbgwbo', 'tnatonat', 'pernzcvr', 'qrrcguebng',
  ] },
  { tier: 'block', category: 'sexual', mode: 'word', terms: [
    'phz', 'cebe', 'encr', 'encvat', 'encvfg', 'nany', 'crqb', 'cnrqb', 'zvys', 'qvys', 'pyvg', 'snc', 'svfgvat', 'ahqrf',
  ] },
  { tier: 'block', category: 'sexual', mode: 'phrase', terms: [
    'fhpx zl qvpx', 'fhpx zl pbpx', 'fhpx zl onyyf', 'fraq ahqrf', 'wrex bss', 'wrexvat bss', 'wnpxvat bss',
    'fvg ba zl snpr',
  ] },
  { tier: 'block', category: 'threat', mode: 'exact', terms: [
    'xlf',
  ] },
  { tier: 'block', category: 'threat', mode: 'phrase', terms: [
    'xvyy lbhefrys', 'xvyy lbhefryirf', 'xvyy hefrys', 'xvyy lbfrys', 'xvyy lnfrys', 'arpx lbhefrys',
    'tb unat lbhefrys', 'tb unat hefrys', 'ebcr lbhefrys', 'raq lbhefrys', 'hanyvir lbhefrys', 'fyvg lbhe jevfgf',
    'fyvg he jevfgf', 'qevax oyrnpu', 'ubcr lbh qvr', 'ubcr h qvr', 'ubcr he qrnq', 'ubcr lbh trg pnapre',
    'lbh fubhyq qvr', 'h fubhyq qvr', 'lbh qrfreir gb qvr', 'xvyy lbh vey', 'v xabj jurer lbh yvir',
    'fubbg hc gur fpubby', 'fubbg hc bhe fpubby', 'fubbg hc guvf fpubby', 'fubbg hc fpubby', 'obzo gur fpubby',
    'oybj hc gur fpubby', 'oevat n tha gb fpubby', 'fpubby fubbgre',
  ] },
  { tier: 'block', category: 'selfharm', mode: 'exact', terms: [
    'xzf',
  ] },
  { tier: 'block', category: 'selfharm', mode: 'phrase', terms: [
    'xvyy zlfrys', 'v jnag gb qvr', 'v jnaan qvr', 'raq zl yvsr', 'fyvg zl jevfgf', 'phg zl jevfgf',
    'hanyvir zlfrys', 'unat zlfrys',
  ] },
  { tier: 'mask', category: 'profanity', mode: 'strong', terms: [
    'shpx', 'sipx', 'sphx', 'cuhpx', 'fuvg', 'ovgpu', 'ovngpu', 'ovbgpu', 'olgpu', 'juber', 'nffubyr', 'nefrubyr',
  ] },
  { tier: 'mask', category: 'profanity', mode: 'word', terms: [
    'shx', 'shd', 'spx', 'shp', 'cuhx', 'fulg', 'nff', 'nmm', 'nefr', 'qvpx', 'pbpx', 'cevpx', 'onfgneq', 'qbhpur', 'gjng',
    'jnax', 'gbffre', 'obyybpxf', 'obyybk', 'chffl', 'chffvrf', 'fyhg', 'fxnax', 'gubg', 'ubr', 'frk', 'frkg',
    'obbo', 'gvg', 'cravf', 'intvan', 'nahf', 'ubeal', 'obare', 'ahqr', 'fcnm', 'fcnmm', 'zbsb', 'zsre', 'oryyraq',
    'qhzonff', 'wnpxnff', 'fznegnff', 'sngnff', 'onqnff', 'xvpxnff', 'yneqnff', 'uneqnff', 'unysnff', 'nffung',
    'nffjvcr', 'nffpybja', 'nffsnpr', 'nffurnq', 'qvpxurnq', 'qvpxsnpr', 'qvpxjnq', 'qvpxjrrq', 'qbhpuront',
    'tbqqnza', 'tbqqnzzvg', 'tbqqnzavg', 'tbqnza',
  ] },
  { tier: 'mask', category: 'profanity', mode: 'exact', terms: [
    'fgsh', 'tgsb', 'sx', 'sxa', 'sxvat', 'sxva', 'fzq',
  ] },
  { tier: 'mild', category: 'mild', mode: 'word', terms: [
    'qnza', 'qnzzvg', 'qnzavg', 'uryy', 'penc', 'ohgg', 'cvff', 'gheq', 'ohttre',
  ] },
  { tier: 'mild', category: 'mild', mode: 'exact', terms: [
    'jgs', 'jgu', 'bzst', 'yzsnb', 'szy', 'ssf',
  ] },
];

/**
 * Names only (callsigns, account usernames, room names, bot names) — hate figures / symbols that are fine to
 * discuss in chat (history class) but not to wear as a name.
 */
export const NAME_ONLY_GROUPS: readonly TermGroup[] = [
  { tier: 'block', category: 'hate', mode: 'strong', terms: [
    'uvgyre', 'fjnfgvxn', 'trfgncb', 'nhfpujvgm', 'ubybpnhfg', 'shuere',
  ] },
  { tier: 'block', category: 'hate', mode: 'word', terms: [
    'anmv', 'urvy',
  ] },
];

/**
 * Clean words that contain a listed term (the Scunthorpe problem). A hit that lies entirely inside an occurrence
 * of one of these (after the same normalization) is ignored: "Scunthorpe", "cockpit", "therapist", "spicy",
 * "Montenegro". Entries are matched as substrings, so "spice" also covers "spices" / "allspice"; an entry with a
 * space ("spick and span") may span a space, the others never do. Plain text — these are ordinary words.
 */
export const ALLOW_WORDS: readonly string[] = [
  // "ass" family (mostly for completeness: the word-mode match already skips them)
  'class', 'classic', 'classroom', 'assassin', 'assess', 'asset', 'assist', 'assign', 'assume', 'associat', 'assembl',
  'assert', 'bass', 'brass', 'grass', 'glass', 'mass', 'pass', 'compass', 'embassy', 'embarrass', 'harass', 'jurassic',
  'lass', 'sass', 'carcass', 'cassette', 'casserole', 'molasses', 'ambassador', 'assault',
  // strong-term rescues
  'scunthorpe', 'shitake', 'shiitake', 'shitzu', 'shihtzu', 'snigger', 'niggard',
  // rape / rapist / raping
  'grape', 'drape', 'scrape', 'trapeze', 'rapeseed', 'parapet', 'therapeu', 'therapist', 'scraping', 'draping',
  'rappe', 'rapping', 'rappel', // a doubled letter is absorbed: wrapped, trapped, rapper, wrapping, rapping
  // anal / anus
  'analys', 'analyz', 'analog', 'analyt', 'canal', 'banal', 'annal', 'annus', 'janus', 'uranus',
  // penis / sex / sext
  'penistone', 'sussex', 'essex', 'middlesex', 'sextant', 'sextet', 'sexton', 'sextuple', 'sextil',
  // dick
  'dickens', 'dickinson', 'dickson', 'dickey', 'dicker', 'moby dick', 'mobydick',
  // cock
  'cockpit', 'cocktail', 'cockroach', 'peacock', 'hancock', 'hitchcock', 'babcock', 'woodcock', 'gamecock',
  'shuttlecock', 'weathercock', 'stopcock', 'ballcock', 'haycock', 'poppycock', 'cockatoo', 'cockatiel', 'cockney',
  'cockle', 'cocky', 'cockerel', 'cocker', 'cockscomb', 'cockeyed', 'cocked', 'cocking', 'cocksure',
  // hell / tit / butt / cum
  'hello', 'shell', 'michelle', 'othello', 'title', 'titan', 'titer', 'titre', 'titin', 'titter', 'titillat',
  'butter', 'button', 'buttress', 'cumin', 'cucumber', 'document', 'circumst', 'accumul', 'cumulat', 'cumulus', 'scum',
  'succumb', 'cumbersome', 'incumbent', 'cummings',
  // slur look-alikes
  'raccoon', 'racoon', 'cocoon', 'tycoon', 'coonhound', 'spice', 'spicy', 'spicier', 'spiciest', 'spicey', 'spicing',
  'spicer', 'conspicu', 'auspic', 'suspic', 'despic', 'hospice', 'perspica', 'spicule', 'spick and span',
  'homogen', 'homophon', 'homonym', 'homolog', 'homozyg', 'homophob', 'homosexual', 'homo sapien', 'homosapien',
  'homo erectus', 'montenegro', 'negroni', 'pakistan', 'dagobah', 'honkytonk', 'honky tonk', 'injunction', 'squawk',
  'van dyke', 'vandyke', 'retardant', 'stard', 'leotard', 'tardis', 'tardy', 'tardi', 'petard', 'gobbledygook',
  'gobbledegook', 'heebie', 'nazir',
  'chink in the armo', 'chinks in the armo', 'chink in his armo', 'chink in her armo', 'chink in their armo',
  'chink in its armo', 'chink in my armo', 'chink in your armo', 'chink in our armo',
  // sexual-term look-alikes
  'hoed', 'hoeing', 'hoedown', 'milford', 'milfoil', 'denude', 'thorny', 'thoth', 'torpedo', 'pedomet', 'pedolog',
  'speedo', 'booboo', 'woop',
  // profanity look-alikes
  'swank', 'prickl', 'pussycat', 'pussy cat', 'pussywillow', 'pussy willow', 'pussyfoot', 'arsenal', 'arsenic',
  'arsene', 'parse', 'sparse', 'coarse', 'hoarse', 'rehearse', 'hearse', 'marseille', 'butte',
  // real given names and surnames seen on class rosters (a student must be able to use their own name)
  'harshit', 'kshitij', 'yamashita', 'kinoshita', 'matsushita', 'morishita', 'shittu', 'dikshit', 'hiscock',
  'alcock', 'adcock', 'laycock', 'glasscock', 'cockburn', 'cockrell', 'kuntz', 'analise', 'analiese', 'anneliese',
  'annaliese', 'kuntal', 'analisa', 'anusha', 'anushka', 'shital', 'shitij', 'ashit', // ashit also covers Ashita / Ashitaka
  'riddick', 'farseer',
  // US / Idaho place names and surnames found by the false-positive corpus (fpCorpus.test.ts): Bonner County and
  // Bonners Ferry, Idaho (a repeated letter is absorbed, so the double-n spelling read as a masked word); three
  // Idaho landmarks and a Lake Lowell fish (starred in strict mode; multi-word entries also read across an
  // apostrophe, for a possessive); a Minnesota city, a hound breed written as two words and an everyday phrase
  'bonner', 'hells canyon', 'hells gate', 'hells half acre', 'crappie', 'coon rapids', 'coon hound', 'tit for tat',
];

/**
 * Number codes (hate symbols written in digits). Digits don't change under ROT13, so these are stored ROT5 (each
 * digit + 5, mod 10) for the same no-grep reason; see rot5(). Chat: the code standing on its own (a digit run,
 * optionally split by single separators such as a space or a dot) is starred out and logged — mask tier, so an
 * innocent number costs no strike. Names: refused when one whole digit run of the name, or one group of it between
 * separators (not a decimal point), spells the code (the same runs as chat, engine.ts digitRuns; digit groups split
 * by letters are separate numbers).
 */
export const NUMERIC_TERMS: readonly { code: string; category: Category }[] = [
  { code: '6933', category: 'hate' },
];

/** Decode one ROT5 digit code. */
export function rot5(s: string): string {
  return s.replace(/[0-9]/g, (d) => String((d.charCodeAt(0) - 48 + 5) % 10));
}

/** Endings a word / phrase term may carry ("fucking", "bitches", "shitty", "hoez"). Plain text. */
export const SUFFIXES: readonly string[] = [
  's', 'es', 'd', 'ed', 'er', 'ers', 'ing', 'ings', 'in', 'ins', 'y', 'ie', 'ies', 'ier', 'iest', 'z', 'ez',
];

/**
 * Ordinary short words: a word-mode term spelled across spaces is ignored when EVERY piece is one of these
 * ("an al" is not an evasion). Plain text.
 */
export const COMMON_SHORT_WORDS: readonly string[] = [
  'a', 'i', 'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'hi', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of',
  'oh', 'ok', 'on', 'or', 'so', 'to', 'up', 'us', 'we', 'al', 'ya', 'yo', 'ur', 'im', 'id', 'ok', 'uh', 'um', 'ah',
];
