import { describe, expect, it, vi } from "vitest";
import type { Program } from "@coral-xyz/anchor";
import {
  checkVersionCompatibility,
  requireVersionCompatibility,
  getFeaturesForVersion,
  SDK_PROTOCOL_VERSION,
  SDK_MIN_PROTOCOL_VERSION,
  VersionStatus,
} from "../version";
import { VERSION } from "../index";
import { PROGRAM_ID } from "../constants";

function makeProgram(
  onChainVersion: number,
  onChainMinVersion: number,
): Program {
  const fetch = vi.fn().mockResolvedValue({
    protocolVersion: onChainVersion,
    minSupportedVersion: onChainMinVersion,
  });

  return {
    programId: PROGRAM_ID,
    account: {
      protocolConfig: {
        fetch,
      },
    },
  } as unknown as Program;
}

describe("version compatibility", () => {
  it("exact match => Current and compatible", async () => {
    const info = await checkVersionCompatibility(makeProgram(1, 1));
    expect(info.status).toBe(VersionStatus.Current);
    expect(info.compatible).toBe(true);
    expect(info.warning).toBeNull();
    expect(info.error).toBeNull();
  });

  it("on-chain older but supported => CompatibleOld", async () => {
    const info = await checkVersionCompatibility(makeProgram(1, 1), {
      sdkVersion: 2,
      sdkMinVersion: 1,
    });
    expect(info.status).toBe(VersionStatus.CompatibleOld);
    expect(info.compatible).toBe(true);
    expect(info.warning).toBeTruthy();
  });

  it("on-chain too old => ProtocolTooOld and incompatible", async () => {
    const info = await checkVersionCompatibility(makeProgram(0, 0), {
      sdkVersion: 2,
      sdkMinVersion: 1,
    });
    expect(info.status).toBe(VersionStatus.ProtocolTooOld);
    expect(info.compatible).toBe(false);
    expect(info.error).toBeTruthy();
  });

  it("sdk too old => SdkTooOld and incompatible", async () => {
    const info = await checkVersionCompatibility(makeProgram(2, 2));
    expect(info.status).toBe(VersionStatus.SdkTooOld);
    expect(info.compatible).toBe(false);
    expect(info.error).toBeTruthy();
  });

  it("sdk behind => SdkBehind and compatible with warning", async () => {
    const info = await checkVersionCompatibility(makeProgram(2, 1));
    expect(info.status).toBe(VersionStatus.SdkBehind);
    expect(info.compatible).toBe(true);
    expect(info.warning).toBeTruthy();
  });

  it("requireVersionCompatibility returns info for compatible version", async () => {
    const info = await requireVersionCompatibility(makeProgram(1, 1));
    expect(info.compatible).toBe(true);
  });

  it("requireVersionCompatibility throws for incompatible version", async () => {
    await expect(
      requireVersionCompatibility(makeProgram(2, 2)),
    ).rejects.toThrow("SDK protocol version");
  });

  it("getFeaturesForVersion(v0) => all false", () => {
    const features = getFeaturesForVersion(0);
    expect(Object.values(features).every((flag) => flag === false)).toBe(true);
  });

  it("getFeaturesForVersion(v1) => all v1 flags true", () => {
    const features = getFeaturesForVersion(1);
    expect(Object.values(features).every((flag) => flag === true)).toBe(true);
  });

  it("getFeaturesForVersion(unknown future) accumulates known features", () => {
    const v1 = getFeaturesForVersion(1);
    const v10 = getFeaturesForVersion(10);
    expect(v10).toEqual(v1);
  });

  it("SDK_PROTOCOL_VERSION constant is 1", () => {
    expect(SDK_PROTOCOL_VERSION).toBe(1);
  });

  it("SDK_MIN_PROTOCOL_VERSION constant is 1", () => {
    expect(SDK_MIN_PROTOCOL_VERSION).toBe(1);
  });

  it("version info includes sdkPackageVersion matching exported VERSION", async () => {
    const info = await checkVersionCompatibility(makeProgram(1, 1));
    expect(info.sdkPackageVersion).toBe(VERSION);
  });
});
