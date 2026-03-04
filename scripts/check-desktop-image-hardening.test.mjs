import test from "node:test";
import assert from "node:assert/strict";

import {
  aptBlockContainsPackage,
  extractAptInstallBlock,
  tokenizeAptBlock,
} from "./check-desktop-image-hardening.mjs";

test("tokenizeAptBlock parses apt install list tokens", () => {
  const aptBlock = String.raw`RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    # comment line
    ripgrep fd-find \
    && locale-gen en_US.UTF-8`;

  const tokens = tokenizeAptBlock(aptBlock);
  assert.ok(tokens.includes("curl"));
  assert.ok(tokens.includes("ca-certificates"));
  assert.ok(tokens.includes("ripgrep"));
  assert.ok(tokens.includes("fd-find"));
});

test("aptBlockContainsPackage returns true only for present packages", () => {
  const aptBlock = String.raw`RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ripgrep fd-find \
    && locale-gen en_US.UTF-8`;

  assert.equal(aptBlockContainsPackage(aptBlock, "curl"), true);
  assert.equal(aptBlockContainsPackage(aptBlock, "ripgrep"), true);
  assert.equal(aptBlockContainsPackage(aptBlock, "imagemagick"), false);
});

test("aptBlockContainsPackage rejects unsafe package-name input", () => {
  const aptBlock = "RUN apt-get install -y curl && locale-gen en_US.UTF-8";
  assert.throws(
    () => aptBlockContainsPackage(aptBlock, "curl|ripgrep"),
    /invalid package name guard/,
  );
});

test("extractAptInstallBlock returns the expected apt install segment", () => {
  const dockerfile = String.raw`FROM ubuntu:24.04
RUN echo pre
RUN apt-get update && apt-get install -y --no-install-recommends \
  curl ca-certificates \
  && locale-gen en_US.UTF-8
RUN echo post`;

  const aptBlock = extractAptInstallBlock(dockerfile);
  assert.match(aptBlock, /apt-get install -y --no-install-recommends/);
  assert.match(aptBlock, /locale-gen en_US\.UTF-8/);
});
