#!/usr/bin/env node
// Fake `pi` for test/service.test.ts: records {argv, env, cwd} to
// <dirname($PI_AGENTS_HOME)>/pi-records/<PI_AGENTS_ID>.json, then stays alive like a running Pi.
// `--warmup` as the only argument exits at once (lets the test pay the first-exec cost up front).
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--warmup") process.exit(0);
const e = process.env;
const record = {
  argv,
  env: { PI_AGENTS_ID: e.PI_AGENTS_ID, PI_AGENTS_HOME: e.PI_AGENTS_HOME, HERDR_ENV: e.HERDR_ENV },
  cwd: process.cwd(),
};
const dir = path.join(path.dirname(e.PI_AGENTS_HOME), "pi-records");
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `${e.PI_AGENTS_ID}.json`);
fs.writeFileSync(`${out}.tmp`, JSON.stringify(record));
fs.renameSync(`${out}.tmp`, out);
setInterval(() => {}, 1 << 30);
