import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * The chime is synthesized on one shared AudioContext. A browser keeps that
 * context suspended until the page has had a user gesture, so run-notifications
 * primes it on every pointerdown and keydown, and it reads the chime's answer
 * (were the tones scheduled?) to decide whether a system notification needs a
 * sound of its own. jsdom has no Web Audio, so a recording context stands in.
 */

type FakeContextState = 'suspended' | 'running' | 'interrupted' | 'closed';

/** How the contexts' resume() behaves: resolve, reject (a closed context) or stay pending (held back by the autoplay policy). */
let resumeOutcome: 'resolve' | 'reject' | 'pending' = 'resolve';

/** The state a new context starts in. */
let initialState: FakeContextState = 'suspended';

/** Every context the code under test created. */
let contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  state: FakeContextState = initialState;
  currentTime = 12;
  destination = {};
  resumeCalls = 0;
  /** When each oscillator the chime scheduled starts. */
  toneStarts: number[] = [];
  /** Completes a pending resume(), as a later user gesture would. */
  finishPendingResume: (() => void) | null = null;

  constructor() {
    contexts.push(this);
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (resumeOutcome === 'reject') {
      return Promise.reject(new Error('Cannot resume a closed AudioContext'));
    }
    if (resumeOutcome === 'pending') {
      return new Promise((resolve) => {
        this.finishPendingResume = () => {
          this.state = 'running';
          resolve();
        };
      });
    }
    this.state = 'running';
    return Promise.resolve();
  }

  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime: () => undefined },
      connect: () => undefined,
      start: (when: number) => {
        this.toneStarts.push(when);
      },
      stop: () => undefined,
    };
  }

  createGain() {
    return {
      gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: () => undefined,
    };
  }
}

/**
 * The AudioContext constructor is read once, when the module loads, so each test stubs it
 * first (null leaves Web Audio out, as in jsdom) and then loads a fresh module.
 */
const loadSoundHelpers = async ({ audioContext = FakeAudioContext as unknown } = {}) => {
  if (audioContext) {
    vi.stubGlobal('AudioContext', audioContext);
  }
  vi.resetModules();
  return import('@/shared/utils');
};

beforeEach(() => {
  // The sound is on unless the stored preference says otherwise.
  localStorage.clear();
  resumeOutcome = 'resolve';
  initialState = 'suspended';
  contexts = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('priming while the sound is off creates no context', async () => {
  const { primeNotificationSound, setNotificationSoundEnabled } = await loadSoundHelpers();
  setNotificationSoundEnabled(false);

  primeNotificationSound();

  assert.equal(contexts.length, 0);
});

test('priming creates the shared context and resumes it, and leaves a running one alone', async () => {
  const { primeNotificationSound } = await loadSoundHelpers();

  primeNotificationSound();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].resumeCalls, 1);

  // The stand-in resumes at once, so the next gestures find it running.
  primeNotificationSound();
  primeNotificationSound();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].resumeCalls, 1);

  // iOS interrupts a running context on calls and app switches; the next gesture resumes it.
  contexts[0].state = 'interrupted';
  primeNotificationSound();
  assert.equal(contexts[0].resumeCalls, 2);
});

test('priming swallows a resume that fails and a context that cannot be created', async () => {
  resumeOutcome = 'reject';
  const { primeNotificationSound } = await loadSoundHelpers();

  assert.doesNotThrow(() => primeNotificationSound());
  // Let the rejection settle: left unhandled, it would fail the run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(contexts[0].resumeCalls, 1);

  const { primeNotificationSound: primeWithoutContext } = await loadSoundHelpers({
    audioContext: class {
      constructor() {
        throw new Error('Too many AudioContexts');
      }
    },
  });
  assert.doesNotThrow(() => primeWithoutContext());
});

test('a chime while the sound is off resolves false and creates no context', async () => {
  const { playChatCompletionSound, playNotificationSound, setNotificationSoundEnabled } = await loadSoundHelpers();
  setNotificationSoundEnabled(false);

  assert.equal(await playNotificationSound(), false);
  assert.equal(await playChatCompletionSound(), false);
  assert.equal(contexts.length, 0);
});

test('a chime resumes a suspended context and resolves true with both tones scheduled', async () => {
  const { playNotificationSound } = await loadSoundHelpers();

  assert.equal(await playNotificationSound(), true);

  assert.equal(contexts[0].resumeCalls, 1);
  assert.equal(contexts[0].toneStarts.length, 2);
});

test('a chime resumes a context iOS interrupted before it plays', async () => {
  initialState = 'interrupted';
  const { playNotificationSound } = await loadSoundHelpers();

  assert.equal(await playNotificationSound(), true);

  assert.equal(contexts[0].resumeCalls, 1);
  assert.equal(contexts[0].toneStarts.length, 2);
});

test('a chime on a running context plays without resuming it', async () => {
  initialState = 'running';
  const { playChatCompletionSound } = await loadSoundHelpers();

  assert.equal(await playChatCompletionSound(), true);

  assert.equal(contexts[0].resumeCalls, 0);
  assert.equal(contexts[0].toneStarts.length, 2);
});

test('a chime whose resume fails resolves false and plays nothing', async () => {
  resumeOutcome = 'reject';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { playNotificationSound } = await loadSoundHelpers();

  assert.equal(await playNotificationSound(), false);

  assert.equal(contexts[0].toneStarts.length, 0);
});

test('a chime the autoplay policy holds back resolves false in time and never plays late', async () => {
  resumeOutcome = 'pending';
  const { playNotificationSound } = await loadSoundHelpers();
  vi.useFakeTimers();

  let answer: boolean | null = null;
  const chime = playNotificationSound().then((scheduled) => {
    answer = scheduled;
  });
  await vi.advanceTimersByTimeAsync(999);
  assert.equal(answer, null);
  await vi.advanceTimersByTimeAsync(1);
  await chime;
  assert.equal(answer, false);

  // A later gesture lets the context run: the held-back chime stays silent, the next one plays.
  contexts[0].finishPendingResume?.();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(contexts[0].toneStarts.length, 0);

  assert.equal(await playNotificationSound(), true);
  assert.equal(contexts[0].toneStarts.length, 2);
});

test('force plays the chime while the sound is off', async () => {
  const { playChatCompletionSound, playNotificationSound, setNotificationSoundEnabled } = await loadSoundHelpers();
  setNotificationSoundEnabled(false);

  assert.equal(await playNotificationSound({ force: true }), true);
  assert.equal(await playChatCompletionSound({ force: true }), true);

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].toneStarts.length, 4);
});

test('without Web Audio a chime resolves false and priming does nothing', async () => {
  const { playNotificationSound, primeNotificationSound } = await loadSoundHelpers({ audioContext: null });

  assert.doesNotThrow(() => primeNotificationSound());
  assert.equal(await playNotificationSound(), false);
  assert.equal(await playNotificationSound({ force: true }), false);
});
