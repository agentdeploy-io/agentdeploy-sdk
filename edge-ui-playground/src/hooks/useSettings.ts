import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "edge-console-settings";

interface PersistedSettings {
  paused: boolean;
}

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { paused: false };
}

function persistSettings(s: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

const listeners = new Set<() => void>();
let current = loadSettings();

function notify() {
  for (const fn of listeners) fn();
}

export function useSettingsState() {
  const [state, setState] = useState(current);

  useEffect(() => {
    const listener = () => setState({ ...current });
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  const setPaused = useCallback((paused: boolean) => {
    current = { ...current, paused };
    persistSettings(current);
    notify();
  }, []);

  return { ...state, setPaused };
}
