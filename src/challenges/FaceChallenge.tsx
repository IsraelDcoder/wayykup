import React, { useCallback, useEffect, useRef } from 'react';
import { Platform, Text, View } from 'react-native';
import type { FaceGesture } from './faceMachine';
import { styles } from './challengeStyles';
import { isNativeAlarmAvailable } from '../../modules/wayykup-alarm';

export type FaceChallengeProps = {
  active: boolean;
  preview?: boolean;
  onComplete: (result: { durationMs: number; attempts: number; sequence: FaceGesture[] }) => void;
  onFallback: (reason: string, result: { durationMs: number; attempts: number }) => void;
  trackEvent: (name: string, properties: Record<string, string | number | boolean>) => void;
};

const NativeFaceChallenge = React.lazy(() => import('./FaceChallengeNative').then((module) => ({
  default: module.FaceChallengeNative,
})));

type ErrorBoundaryProps = {
  children: React.ReactNode;
  fallback: React.ReactNode;
  onError: (error: Error) => void;
};

class NativeChallengeErrorBoundary extends React.Component<ErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export function FaceChallenge(props: FaceChallengeProps) {
  const { active, onFallback, preview, trackEvent } = props;
  const unsupported = Platform.OS === 'web' || !isNativeAlarmAvailable;
  const fallbackSent = useRef(false);
  const reportFallback = useCallback((reason: string) => {
    if (!active || fallbackSent.current) return;
    fallbackSent.current = true;
    trackEvent('challenge_fallback_used', {
      type: 'face',
      mode: 'gesture_sequence',
      duration_ms: 0,
      attempts: 0,
      gesture_sequence: '',
      reason,
      preview: preview ?? false,
    });
    onFallback(reason, { durationMs: 0, attempts: 0 });
  }, [active, onFallback, preview, trackEvent]);

  useEffect(() => {
    if (!active) {
      fallbackSent.current = false;
      return;
    }
    if (unsupported) reportFallback('resource_unavailable');
  }, [active, reportFallback, unsupported]);

  if (unsupported) {
    return (
      <View style={styles.challengePanel}>
        <Text style={styles.challengePrompt}>FACE CHALLENGE NEEDS A DEVELOPMENT BUILD</Text>
        <Text style={styles.challengeHint}>On-device face detection is unavailable here. The selected fallback will be used.</Text>
      </View>
    );
  }
  return (
    <NativeChallengeErrorBoundary
      fallback={(
        <View style={styles.challengePanel}>
          <Text style={styles.challengePrompt}>FACE DETECTION UNAVAILABLE</Text>
          <Text style={styles.challengeHint}>Switching to your selected fallback challenge.</Text>
        </View>
      )}
      onError={(error) => {
        console.error('Face Challenge native module could not load.', error);
        reportFallback('resource_unavailable');
      }}
    >
      <React.Suspense fallback={<View style={styles.challengePanel}><Text style={styles.challengeHint}>Starting on-device face detection…</Text></View>}>
        <NativeFaceChallenge {...props} />
      </React.Suspense>
    </NativeChallengeErrorBoundary>
  );
}
