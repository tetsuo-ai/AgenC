import { describe, it, expect } from 'vitest';
import { UnifiedTelemetryCollector } from '../telemetry/collector.js';
import {
  buildCalibrationBins,
  computeAgreementRate,
  computeExpectedCalibrationError,
  computeMaxCalibrationError,
  buildCalibrationReport,
  recordCalibrationMetrics,
} from './calibration.js';

describe('eval/calibration', () => {
  it('builds calibration bins and computes ECE/MCE', () => {
    const samples = [
      { confidence: 0.1, correct: true },
      { confidence: 0.2, correct: true },
      { confidence: 0.9, correct: false },
      { confidence: 0.8, correct: false },
    ];

    const bins = buildCalibrationBins(samples, 2);
    const ece = computeExpectedCalibrationError(bins);
    const mce = computeMaxCalibrationError(bins);

    expect(bins).toHaveLength(2);
    expect(ece).toBeGreaterThan(0);
    expect(mce).toBeGreaterThan(0);
  });

  it('computes verifier/judge agreement rate', () => {
    const agreement = computeAgreementRate([
      { verifierVerdict: 'pass', judgeVerdict: 'pass', confidence: 0.9 },
      { verifierVerdict: 'fail', judgeVerdict: 'pass', confidence: 0.2 },
      { verifierVerdict: 'needs_revision', judgeVerdict: 'needs_revision', confidence: 0.6 },
    ]);

    expect(agreement).toBeCloseTo(2 / 3, 6);
  });

  it('builds calibration report with stratification and confidence direction flags', () => {
    const samples = [
      {
        confidence: 0.95,
        correct: false,
        taskType: 'qa',
        rewardLamports: 200_000_000,
        verifierGated: true,
      },
      {
        confidence: 0.25,
        correct: true,
        taskType: 'qa',
        rewardLamports: 500_000,
        verifierGated: true,
      },
      {
        confidence: 0.8,
        correct: true,
        taskType: 'planning',
        rewardLamports: 2_000_000,
        verifierGated: false,
      },
    ];

    const comparisons = [
      {
        verifierVerdict: 'pass',
        judgeVerdict: 'fail',
        confidence: 0.95,
        taskType: 'qa',
        rewardLamports: 200_000_000,
        verifierGated: true,
      },
      {
        verifierVerdict: 'pass',
        judgeVerdict: 'pass',
        confidence: 0.8,
        taskType: 'planning',
        rewardLamports: 2_000_000,
        verifierGated: false,
      },
    ];

    const report = buildCalibrationReport(samples, comparisons, { binCount: 5 });

    expect(report.overall.sampleCount).toBe(3);
    expect(report.byTaskType.qa.sampleCount).toBe(2);
    expect(report.byTaskType.planning.sampleCount).toBe(1);
    expect(report.byRewardTier.high.sampleCount).toBe(1);
    expect(report.byRewardTier.medium.sampleCount).toBe(1);
    expect(report.byRewardTier.low.sampleCount).toBe(1);
    expect(report.byVerifierGate.gated.sampleCount).toBe(2);
    expect(report.byVerifierGate.ungated.sampleCount).toBe(1);
    expect(report.overconfidentBinIndices.length + report.underconfidentBinIndices.length).toBeGreaterThan(0);
  });

  it('records calibration metrics using existing telemetry collector API', () => {
    const report = buildCalibrationReport(
      [{ confidence: 0.7, correct: true }],
      [{ verifierVerdict: 'pass', judgeVerdict: 'pass', confidence: 0.7 }],
      { binCount: 4 },
    );

    const collector = new UnifiedTelemetryCollector();
    recordCalibrationMetrics(report, collector);

    const snapshot = collector.getSnapshot();
    expect(Object.keys(snapshot.gauges).some((name) => name.startsWith('agenc.eval.calibration_error'))).toBe(true);
  });
});
