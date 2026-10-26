import { createContext } from 'react';
import type { Checklist } from './api.js';
import type { AcrView } from './ExportView.js';
import type { PdfEntry, ScanState } from './ScanView.js';
import type { StatusFilter } from './ChecklistView.js';

/*
 * For render tests only: the state a screen shows first, so a static render
 * can show a scan in progress, an open review form or a draft ACR without a
 * server. The app never provides it; with the default (empty) value every
 * screen starts empty and loads its data as usual.
 */

export interface InitialState {
  screen?: 'report' | 'scan' | 'checklist' | 'export';
  scan?: { urls?: string; profile?: string; pdfs?: PdfEntry[]; state?: ScanState };
  checklist?: { checklist?: Checklist; filter?: StatusFilter; open?: string; error?: string };
  review?: { outcome?: 'pass' | 'fail' | 'not-applicable'; reviewer?: string; error?: string };
  export?: { acr?: AcrView; status?: string; error?: string };
}

export const Initial = createContext<InitialState>({});
