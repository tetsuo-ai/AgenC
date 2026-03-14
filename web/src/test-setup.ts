Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? false : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }),
});

import { afterEach, beforeEach } from 'vitest';

interface MemoryStorage {
  [key: string]: string;
}

function createMemoryStorage() {
  const store: MemoryStorage = {};

  return {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = `${value}`;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
    key: (index: number) => {
      const keys = Object.keys(store);
      return keys[index] ?? null;
    },
    get length() {
      return Object.keys(store).length;
    },
  };
}

const memoryLocalStorage = createMemoryStorage();

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: memoryLocalStorage,
});

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: memoryLocalStorage,
});

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => window.setTimeout(() => cb(Date.now()), 0);
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
