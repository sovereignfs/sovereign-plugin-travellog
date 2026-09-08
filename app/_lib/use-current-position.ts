'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
 *
 * `watch: true` keeps following the device after the first fix
 * (`watchPosition`, cleared on unmount) — Trip Mode's "current position"
 * was a single snapshot before, frozen for the rest of the screen's life.
 */
export function useCurrentPosition(options: { watch?: boolean } = {}): UseCurrentPositionResult {
  const { watch = false } = options;
  const [state, setState] = useState<CurrentPositionState>({ status: 'idle', coords: null });
  const watchIdRef = useRef<number | null>(null);

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ status: 'unavailable', coords: null });
      return;
    }
    setState({ status: 'loading', coords: null });
    const onSuccess = (position: GeolocationPosition): void => {
      setState({
        status: 'granted',
        coords: { lat: position.coords.latitude, lng: position.coords.longitude },
      });
    };
    const onError = (error: GeolocationPositionError): void => {
      setState((current) => ({
        status: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable',
        // A transient error mid-watch keeps the last known fix rather than blanking it.
        coords: error.code === error.PERMISSION_DENIED ? null : current.coords,
      }));
    };
    if (watch) {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = navigator.geolocation.watchPosition(
        onSuccess,
        onError,
        GEOLOCATION_OPTIONS,
      );
    } else {
      navigator.geolocation.getCurrentPosition(onSuccess, onError, GEOLOCATION_OPTIONS);
    }
  }, [watch]);

  useEffect(() => {
    return () => {
      if (
        watchIdRef.current !== null &&
        typeof navigator !== 'undefined' &&
        navigator.geolocation
      ) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return { ...state, request };
}
