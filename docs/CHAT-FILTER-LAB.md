# Chat Filter Case Study

A lab on how Voidswarm's rule-based chat filter decides, where it is wrong, and the privacy trade-off of logging chat. Esc menu > **Chat Filter Case Study** (any screen except the title; offline or online, because it only runs the shared filter on fixed lines).

Standards (Quark catalog ids, all present): `9-12.AITA.AIM.4` (draft; rules vs data-driven methods), `9-12.CS.3.3` (privacy trade-offs of collecting personal information), `9-12.CS.3.4` (benefits and harms).

- **Predict the filter:** 8 harmless case lines. The student predicts the result, reveals the real strict and standard results, then gives their own call (OK / Not OK / It depends). The outcomes are computed by the real filter (`filterChat`, built-in lists only) and pinned by `filterLabInfo.test.ts`, so a word-list change that alters a case fails a test.
- **Check your thinking:** 4 questions, scored as the fraction right (first submit only is reported).
- **Case study report:** the student's own analysis (rules vs ML; benefit, risk and safeguard of the chat log), with their case table attached.
- **Safety:** no case line contains a blocked term, nothing decodes the lists, and there is no free-text box to probe the filter with. A student can already see the filter work in normal chat; the lab does not add a tester.

## What the cases teach
Right to stay quiet: the Scunthorpe problem (boundary-aware matching plus an allowlist). Misses a human would care about: an insult, an exclusion, and a line like "I will find you after school" that passes because the filter knows words, not intent. Strict vs standard: one mild word changes with the setting.

## Quark
`chat-filter-quiz` (practice, honest fraction-right score) and `chat-filter-report` (evidence, `evaluated`, student text only) are in `quark-manifest.json` (version 0.2.0); a teacher must re-approve it. `FILTER_LAB_REPORTING` in `src/client/quark.ts` is on.

## Known gap, found while building this
The filter passes direct-sounding threats made of ordinary words (for example "I will hurt you after school") and some worrying statements. That is how a word list works; the host-managed custom terms and moderator review are the planned cover. See `docs/MODERATION.md`.
