import { useRef, useCallback } from "react";

export function useDebounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  return useCallback((...args: unknown[]) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]) as unknown as T;
}
