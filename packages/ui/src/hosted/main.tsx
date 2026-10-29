import '../zod-config.js';
import { createRoot } from 'react-dom/client';
import bundled from 'virtual:widedoor-data';
import 'virtual:widedoor-report.css';
import '../ui.css';
import '../hosted.css';
import { toUiData } from '../data.js';
import { HostedApp } from './HostedApp.js';

const root = document.getElementById('root');
if (!root) throw new Error('the page has no #root element');
createRoot(root).render(<HostedApp data={toUiData(bundled)} />);
