import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { hydrateAuth } from './lib/auth';
import { isTauri } from './lib/tauri';
import './styles.css';

// Mark the Tauri-host vs vite-dev distinction on <html> so CSS can
// branch on it (the body background swaps between vibrancy-ready
// translucent and a plain opaque white in browser-mode).
if (isTauri()) {
  document.documentElement.dataset.tauri = '1';
}

// Block on the OS-keychain read so React's first render gets an
// accurate authed/not-authed state.
hydrateAuth().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
