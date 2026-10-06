# Lag Lab

A teaching tool for the networking standards (Idaho 9-12 CS 2024: `9-12.CS.4.2` issues that impact network functionality, `9-12.CS.4.3` data flow in Internet-based services). Esc menu > **Lag Lab**, in offline play only (that is where the game can make the network worse on purpose). The panel is docked, so the match keeps running while you change it.

- **Model** (`src/client/net/lagModel.ts`, wired in `LocalTransport`): added ping (half each way), jitter, and loss. Voidswarm uses a WebSocket (TCP), so a "lost" message is re-sent and everything behind it waits: loss shows up as a stall and a burst, never a skipped update. Messages never reorder. All zero (the default) is the old instant delivery.
- **Prediction switch** (`GameClient.predictionEnabled`): off, your own ship waits for the server (one round trip), which shows why prediction exists. It resets to on with every new connection.
- **Live readouts:** ping (the game's own ping message), jitter and the interpolation buffer (from `RenderClock`), and the stall count.
- **Student work:** a trial notebook (settings plus the measured numbers and how it felt), four predict-and-check questions, and a written lab report. The report can be copied, or sent to the teacher through Quark.

## Quark
Activities `lag-lab-quiz` (practice, an honest fraction-right score, first submit only) and `lag-lab-report` (evidence, student text, no score) are drafted in `quark-manifest.lag-lab.draft.json`. **Reporting is off** (`LAG_LAB_REPORTING` in `src/client/quark.ts`) until Quark's catalog contains the networking standards and a teacher has approved the manifest; reports for ids that are not in the approved manifest are refused.
