// Child process for test/tmux.test.ts: records its argv, env, and cwd as JSON to $TMUX_RECORD_FILE, then stays alive.
import fs from "node:fs";

const out = process.env.TMUX_RECORD_FILE;
if (!out) throw new Error("TMUX_RECORD_FILE not set");
const record = { argv: process.argv.slice(2), env: process.env, cwd: process.cwd() };
fs.writeFileSync(`${out}.tmp`, JSON.stringify(record));
fs.renameSync(`${out}.tmp`, out);
setInterval(() => {}, 1 << 30);
