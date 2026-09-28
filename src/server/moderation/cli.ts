// OWNER: SERVER MODERATION. `npm run mod -- <command>` — see ./cliCore.ts (CLI_USAGE) for the commands.
import { runCli } from './cliCore';

runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
  env: process.env,
}).then((code) => { process.exitCode = code; }, (e: unknown) => {
  process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
  process.exitCode = 1;
});
