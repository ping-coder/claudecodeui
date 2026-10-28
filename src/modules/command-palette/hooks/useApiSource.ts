import { useEffect, useState, type DependencyList } from 'react';

/** What a source holds for its current inputs. */
type ApiSourceState<T> = {
  items: T[];
  // Status of the response the items came from; null while disabled, before the first response, or after a
  // network error. A failed response leaves no items, so this is the only way to tell why.
  status: number | null;
};

// One object for every reset, so resetting a source that holds nothing does not re-render it.
const NO_RESPONSE: ApiSourceState<never> = { items: [], status: null };

/**
 * Fetches one of the palette's lists while `enabled`, again whenever `deps` change: the items of the
 * latest response, and that response's status.
 */
export function useApiSource<T, R = unknown>(opts: {
  enabled: boolean;
  deps: DependencyList;
  fetcher: (signal: AbortSignal) => Promise<Response>;
  parse: (raw: R) => T[];
}): ApiSourceState<T> {
  // What the latest response brought, which the source returns. Items and status share one state so they
  // always describe the same response.
  const [state, setState] = useState<ApiSourceState<T>>(NO_RESPONSE);
  const { enabled, deps, fetcher, parse } = opts;

  useEffect(() => {
    if (!enabled) {
      setState(NO_RESPONSE);
      return;
    }

    const controller = new AbortController();

    fetcher(controller.signal)
      .then(async (response) => {
        // A failed response's body ({ error }, or a proxy's error page) is not a list, so it is not read.
        const items = response.ok ? parse((await response.json()) as R) : [];
        if (controller.signal.aborted) return;
        setState({ items, status: response.status });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState(NO_RESPONSE);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return state;
}
