import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, makeId, nameFromId, nameFromSlug, MAX_SLUG_LENGTH } from "../src/ids.ts";

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4}$/;

test("slugify lowercases and joins words with dashes", () => {
  assert.equal(slugify("Fix the Login Bug"), "fix-the-login-bug");
});

test("slugify strips punctuation and collapses separators", () => {
  assert.equal(slugify("  Fix: the *login* bug!!! (now)  "), "fix-the-login-bug-now");
  assert.equal(slugify("a___b...c"), "a-b-c");
});

test("slugify has no leading or trailing dashes", () => {
  assert.equal(slugify("--hello--world--"), "hello-world");
  assert.equal(slugify("-"), "agent");
});

test("slugify returns 'agent' for empty or all-symbol prompts", () => {
  assert.equal(slugify(""), "agent");
  assert.equal(slugify("   "), "agent");
  assert.equal(slugify("!@#$%^&*()"), "agent");
  assert.equal(slugify("🚀🔥"), "agent");
});

test("slugify transliterates accented latin and drops other unicode", () => {
  assert.equal(slugify("Café déjà vu"), "cafe-deja-vu");
  assert.equal(slugify("Zażółć gęślą jaźń"), "zazolc-gesla-jazn");
  assert.equal(slugify("Straße Øl"), "strasse-ol");
  assert.equal(slugify("修复 bug 123"), "bug-123");
});

test("slugify cuts at a word boundary to stay within 32 chars", () => {
  const s = slugify("Refactor the authentication middleware to support multiple providers");
  assert.ok(s.length <= MAX_SLUG_LENGTH, s);
  assert.equal(s, "refactor-the-authentication");
});

test("slugify hard-cuts a single overlong word", () => {
  const s = slugify("a".repeat(50) + " more");
  assert.equal(s, "a".repeat(32));
});

test("slugify hard cut never ends with a dash", () => {
  const s = slugify("abcdefghijklmnopqrstuvwxyz0123456-x");
  assert.ok(s.length <= MAX_SLUG_LENGTH);
  assert.doesNotMatch(s, /-$/);
});

test("slugify keeps a slug of exactly 32 chars", () => {
  assert.equal(slugify("x".repeat(32)), "x".repeat(32));
  assert.equal(slugify("abcd efgh ijkl mnop qrst uvwx yz"), "abcd-efgh-ijkl-mnop-qrst-uvwx-yz");
  assert.equal(slugify("abcd efgh ijkl mnop qrst uvwx yz1"), "abcd-efgh-ijkl-mnop-qrst-uvwx");
});

test("makeId appends 4 hex chars from injected randomness", () => {
  assert.equal(makeId("Fix the login bug", () => "a1b2"), "fix-the-login-bug-a1b2");
  assert.equal(makeId("", () => "00ff"), "agent-00ff");
});

test("makeId default randomness yields valid ids", () => {
  const prompts = [
    "Fix the login bug",
    "",
    "!!!",
    "Refactor the authentication middleware to support multiple providers",
    "Café déjà vu 🚀",
    "x".repeat(100),
  ];
  for (const p of prompts) {
    const id = makeId(p);
    assert.match(id, ID_RE, id);
    const slug = id.slice(0, -5);
    assert.ok(slug.length <= MAX_SLUG_LENGTH);
  }
});

test("makeId produces different suffixes across calls", () => {
  const ids = new Set(Array.from({ length: 50 }, () => makeId("same")));
  assert.ok(ids.size > 1);
});

test("makeId rejects invalid injected randomness", () => {
  assert.throws(() => makeId("x", () => "XYZ1"));
  assert.throws(() => makeId("x", () => "abc"));
});

test("name is the slug with dashes replaced by spaces", () => {
  assert.equal(nameFromSlug("fix-the-login-bug"), "fix the login bug");
  assert.equal(nameFromId("fix-the-login-bug-a1b2"), "fix the login bug");
  assert.equal(nameFromId("agent-00ff"), "agent");
});
