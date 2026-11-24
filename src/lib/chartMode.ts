import { useSyncExternalStore } from "react";

export type ChartMode = "tick" | "smooth";

const KEY = "gwave:chartMode";
const DEFAULT_MODE: ChartMode = "tick";
const listeners = new Set<() => void>();

let current: ChartMode = DEFAULT_MODE;
let loaded = false;

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const value = window.localStorage.getItem(KEY);
    if (value === "tick" || value === "smooth") current = value;
  } catch {
    return;
  }
}

export function getChartMode(): ChartMode {
  load();
  return current;
}

export function setChartMode(mode: ChartMode) {
  load();
  if (mode === current) return;
  current = mode;
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    return;
  }
  listeners.forEach((listener) => listener());
}

export function toggleChartMode() {
  setChartMode(getChartMode() === "smooth" ? "tick" : "smooth");
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function useChartMode(): ChartMode {
  return useSyncExternalStore(subscribe, getChartMode, () => DEFAULT_MODE);
}
