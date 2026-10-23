import './zod-config.js';
import { createRoot } from 'react-dom/client';
import bundled from 'virtual:widedoor-data';
import 'virtual:widedoor-report.css';
import './ui.css';
import { App } from './App.js';
import { toUiData } from './data.js';

const root = document.getElementById('root');
if (!root) throw new Error('the page has no #root element');
createRoot(root).render(<App data={toUiData(bundled)} />);
