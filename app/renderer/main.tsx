import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少页面容器');
createRoot(root).render(<StrictMode><App /></StrictMode>);
