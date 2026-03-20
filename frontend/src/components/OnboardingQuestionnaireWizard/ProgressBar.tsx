import React from 'react';

type ProgressBarProps = {
  currentStep: number; // 1..totalSteps
  totalSteps: number;
};

export default function ProgressBar(props: ProgressBarProps) {
  const { currentStep, totalSteps } = props;
  const safeTotal = Math.max(1, totalSteps);
  const clampedCurrent = Math.min(Math.max(1, currentStep), safeTotal);
  const percent = (clampedCurrent / safeTotal) * 100;

  return (
    <div className="df-progressBar" aria-label="Progress">
      <div className="df-progressBarFill" style={{ width: `${percent}%` }} />
    </div>
  );
}

