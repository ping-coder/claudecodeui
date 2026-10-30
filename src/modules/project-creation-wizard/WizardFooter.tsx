import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import type { WizardStep } from '@/shared/types';

type WizardFooterProps = {
  step: WizardStep;
  isCreating: boolean;
  isCloneWorkflow: boolean;
  /** Holds the forward button, e.g. while the Template step's list is still loading. */
  isNextDisabled?: boolean;
  /** The result view is open: Done is the only action left. */
  isShowingResult?: boolean;
  onClose: () => void;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
};

const LAST_STEP: WizardStep = 3;

/** Rendered by ProjectCreationWizard to provide its cancel, back, next, create and done actions. */
export default function WizardFooter({
  step,
  isCreating,
  isCloneWorkflow,
  isNextDisabled = false,
  isShowingResult = false,
  onClose,
  onBack,
  onNext,
  onCreate,
}: WizardFooterProps) {
  const { t } = useTranslation();

  if (isShowingResult) {
    return (
      <div className="flex items-center justify-end border-t border-gray-200 p-6 dark:border-gray-700">
        <Button onClick={onClose}>
          <Check className="me-1 h-4 w-4" />
          {t('projectWizard.buttons.done')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between border-t border-gray-200 p-6 dark:border-gray-700">
      <Button variant="outline" onClick={step === 1 ? onClose : onBack} disabled={isCreating}>
        {step === 1 ? (
          t('projectWizard.buttons.cancel')
        ) : (
          <>
            <ChevronLeft className="me-1 h-4 w-4" />
            {t('projectWizard.buttons.back')}
          </>
        )}
      </Button>

      <Button onClick={step === LAST_STEP ? onCreate : onNext} disabled={isCreating || isNextDisabled}>
        {isCreating ? (
          <>
            <Loader2 className="me-2 h-4 w-4 animate-spin" />
            {isCloneWorkflow
              ? t('projectWizard.buttons.cloning', { defaultValue: 'Cloning...' })
              : t('projectWizard.buttons.creating')}
          </>
        ) : step === LAST_STEP ? (
          <>
            <Check className="me-1 h-4 w-4" />
            {t('projectWizard.buttons.createProject')}
          </>
        ) : (
          <>
            {t('projectWizard.buttons.next')}
            <ChevronRight className="ms-1 h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  );
}
