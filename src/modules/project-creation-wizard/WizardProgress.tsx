import { Fragment } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { WizardStep } from '@/shared/types';

type WizardProgressProps = {
  step: WizardStep;
  /** The project exists and the wizard shows its result: every step reads as done. */
  isComplete?: boolean;
};

const STEPS: WizardStep[] = [1, 2, 3];

/** Rendered by ProjectCreationWizard to show which of its three steps is active. */
export default function WizardProgress({ step, isComplete = false }: WizardProgressProps) {
  const { t } = useTranslation();
  const stepLabels: Record<WizardStep, string> = {
    1: t('projectWizard.steps.template'),
    2: t('projectWizard.steps.configure'),
    3: t('projectWizard.steps.confirm'),
  };

  return (
    <div className="px-6 pb-2 pt-4">
      <div className="flex items-center justify-between">
        {STEPS.map((currentStep) => {
          const isDone = isComplete || currentStep < step;

          return (
            <Fragment key={currentStep}>
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
                    isDone
                      ? 'bg-green-500 text-white'
                      : currentStep === step
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-500 dark:bg-gray-700'
                  }`}
                >
                  {isDone ? <Check className="h-4 w-4" /> : currentStep}
                </div>
                <span className="hidden text-sm font-medium text-gray-700 dark:text-gray-300 sm:inline">
                  {stepLabels[currentStep]}
                </span>
              </div>

              {currentStep < STEPS.length && (
                <div
                  className={`mx-2 h-1 flex-1 rounded ${
                    isDone ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
