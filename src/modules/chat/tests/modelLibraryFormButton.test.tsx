import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';
import type { LLMProvider, ProviderModelActions, ProviderModelsDefinition } from '@/shared/types';

/**
 * The model library form's button says what it does in the UI language: add a model, save the
 * edited one, or that the save is under way.
 */

const CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  cursor: {
    OPTIONS: [
      { value: 'auto', label: 'Auto', isCustom: false },
      { value: 'my-model', label: 'My Model', recordId: 3, isCustom: true },
    ],
    DEFAULT: 'auto',
    EFFORT_LEVELS: [],
  },
};

afterEach(async () => {
  await i18n.changeLanguage('en');
});

/** Renders the panel with a create action that waits until the test lets it finish. */
const renderPanel = () => {
  let finishCreate = () => {};
  const actions: ProviderModelActions = {
    create: () => new Promise<void>((resolve) => {
      finishCreate = resolve;
    }),
    update: async () => {},
    remove: async () => {},
    setCustomModelsOnly: async () => {},
  };
  const { container } = render(<ModelLibraryPanel initialProvider="cursor" providerModelCatalog={CATALOG} actions={actions} />);
  const submit = () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).textContent;
  return { submit, finishCreate: () => finishCreate() };
};

/** Fills the form and submits it; the create action stays pending. */
const submitNewModel = () => {
  fireEvent.change(document.getElementById('custom-model-name') as HTMLInputElement, { target: { value: 'New Model' } });
  fireEvent.change(document.getElementById('custom-model-id') as HTMLInputElement, { target: { value: 'new-model' } });
  fireEvent.submit(document.querySelector('form') as HTMLFormElement);
};

test('the button adds, saves an edited model, and shows the save under way', async () => {
  const panel = renderPanel();
  assert.equal(panel.submit(), 'Add model');

  submitNewModel();
  await waitFor(() => assert.equal(panel.submit(), 'Saving…'));
  await act(async () => {
    panel.finishCreate();
  });
  await waitFor(() => assert.equal(panel.submit(), 'Add model'));

  fireEvent.click(screen.getByRole('button', { name: 'Edit My Model' }));
  assert.equal(panel.submit(), 'Save changes');
});

test('in Hebrew the button is named from the Hebrew locale', async () => {
  await i18n.changeLanguage('he');
  const hebrew = i18n.getFixedT('he', 'chat');
  const panel = renderPanel();
  assert.equal(panel.submit(), hebrew('modelLibrary.addModel'));
  // A Hebrew word, or the English one set apart as a fallback: either way not the bare English.
  assert.equal(panel.submit() !== 'Add model', true);

  submitNewModel();
  await waitFor(() => assert.equal(panel.submit(), hebrew('modelLibrary.saving')));
  await act(async () => {
    panel.finishCreate();
  });

  // The edit button is named in Hebrew too.
  fireEvent.click(screen.getByRole('button', { name: hebrew('modelLibrary.editModel', { model: 'My Model' }) }));
  assert.equal(panel.submit(), hebrew('modelLibrary.saveChanges'));
});
