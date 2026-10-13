import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp } from 'antd';
import 'antd/dist/reset.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <AntApp>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </AntApp>
);
