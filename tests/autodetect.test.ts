import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bootstrapManifest } from "../src/autodetect.js";
import { createRuntime } from "../src/runtime.js";

test("createRuntime autodetects a pnpm Node host when no manifest exists", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "update-kit-autodetect-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      name: "demo-host",
      version: "1.2.3",
      repository: "https://github.com/acme/demo-host.git",
      packageManager: "pnpm@9.0.0"
    }, null, 2), "utf8");

    const runtime = await createRuntime({ cwd });
    assert.equal(runtime.manifestInfo.source, "autodetect");
    assert.equal(runtime.manifestInfo.preset, "node-pnpm");
    assert.equal(runtime.manifest.repo, "acme/demo-host");
    assert.equal(runtime.manifest.installStrategy.type, "pnpm_package");
    assert.equal(runtime.manifest.currentVersionSource.type, "package.json");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bootstrapManifest allows targeted overrides while keeping autodetected defaults", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "update-kit-bootstrap-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      name: "demo-host",
      version: "2.0.0",
      repository: "https://github.com/acme/demo-host.git"
    }, null, 2), "utf8");

    const { manifest, info } = await bootstrapManifest({
      cwd,
      overrides: {
        autoUpdatePolicy: "patch"
      }
    });

    assert.equal(info.source, "merged");
    assert.equal(manifest.autoUpdatePolicy, "patch");
    assert.equal(manifest.installStrategy.type, "npm_package");
    assert.equal(manifest.statePath, path.join(cwd, ".update-kit", "state.json"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
