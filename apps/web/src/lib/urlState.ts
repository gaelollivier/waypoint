import { useCallback, useSyncExternalStore } from "react";

/** Read a search param from the URL reactively (re-renders on popstate). */
export function useSearchParam(key: string): string | null {
  const subscribe = useCallback(
    (cb: () => void) => {
      window.addEventListener("popstate", cb);
      return () => window.removeEventListener("popstate", cb);
    },
    []
  );
  const getSnapshot = useCallback(
    () => new URLSearchParams(window.location.search).get(key),
    [key]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Update search params without a full navigation — preserves the path. */
export function setSearchParams(updates: Record<string, string | null>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  const url = window.location.pathname + (qs ? "?" + qs : "");
  history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
