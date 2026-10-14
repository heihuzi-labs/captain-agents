import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/index.css';
import { isWindows } from './ui/platform.ts';

// 样式按这个标记区分两种系统（顶栏留白，见 tokens.css）。
document.documentElement.dataset.platform = isWindows ? 'windows' : 'mac';

const root = document.getElementById('root');
if (!root) throw new Error('缺少页面容器');
createRoot(root).render(<StrictMode><App /></StrictMode>);
