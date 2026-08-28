'use client';

import { useCallback, useState } from 'react';

export type CurrentPositionStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'unavailable';

export interface CurrentPositionState {
  status: CurrentPositionStatus;
  coords: { lat: number; lng: number } | null;
}

export interface UseCurrentPositionResult extends CurrentPositionState {
  /** Triggers (or retries) the browser's geolocation prompt. Safe to call repeatedly. */
  request: () => void;
}

const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 60_000,
};

/**
 * `navigator.geolocation` directly, plugin-local — `sdk.device.geolocation`
 * doesn't exist yet (SPEC.md's "Location source"). Never blocks or throws:
 * a denied/unavailable browser is a normal, expected outcome for GPS
 * check-in (`T.7`'s review checklist — search/manual entry must still work
 * with no location permission granted), never a console error or a crash.
 */
export function useCurrentPosition(): UseCurrentPositionResult {
  const [state, setState] = useState<CurrentPositionState>({ status: 'idle', coords: null });

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ status: 'unavailable', coords: null });
      return;
    }
    setState({ status: 'loading', coords: null });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setState({
          status: 'granted',
          coords: { lat: position.coords.latitude, lng: position.coords.longitude },
        });
      },
      (error) => {
        setState({
          status: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable',
          coords: null,
        });
      },
      GEOLOCATION_OPTIONS,
    );
  }, []);

  return { ...state, request };
}
