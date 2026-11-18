import { defineConfig } from 'vitest/config';

// The shared filter catalogue and the Worker's tests are plain logic; none needs a browser environment.
export default defineConfig({test: {environment: 'node'}});
