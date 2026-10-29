import { createContext } from 'react';
import type { Created } from './api.js';
import type { ScanPhase, ScanForm } from './HostedApp.js';
import type { VerificationState } from './text.js';
import type { VerifyNote } from './VerifyView.js';

/*
 * For render tests only: the state the hosted page shows first, so a static
 * render can show a queued scan, a report or a verification being checked
 * without a server. The page never provides it; with the default (empty)
 * value it starts empty and reads this tab's stored verification.
 */

export interface HostedInitialState {
  form?: Partial<ScanForm>;
  phase?: ScanPhase;
  verification?: VerificationState;
  /** A verification made in this page: its token and methods. */
  created?: Created;
  verify?: VerifyNote;
}

export const HostedInitial = createContext<HostedInitialState>({});
