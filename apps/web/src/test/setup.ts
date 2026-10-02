import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // Panels remember open/closed state; never carry it from one test to the next.
  localStorage.clear();
});
