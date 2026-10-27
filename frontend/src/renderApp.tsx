import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applySharedScreenFromUrl } from './utils/savedScreens';
import { sectionForPath } from './data/sections';
import { writeStored } from './storage/store';
import { SCREEN_STORAGE_KEYS } from './utils/screenStorageKeys';

// A shared screen link becomes the Screener's working state before the first render.
applySharedScreenFromUrl();
// A section URL opens that section, ahead of the tab remembered from last time.
const section = sectionForPath(window.location.pathname);
if (section) writeStored(SCREEN_STORAGE_KEYS.activeTab, section.tab);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
