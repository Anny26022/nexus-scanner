import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applySharedScreenFromUrl } from './utils/savedScreens';

// A shared screen link becomes the Screener's working state before the first render.
applySharedScreenFromUrl();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
