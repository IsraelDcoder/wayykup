import React, { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Platform, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import {
  addAlarmListener,
  startSpeechRecognition,
  stopSpeechRecognition,
} from '../../modules/wayykup-alarm';
import { styles } from './challengeStyles';

type Props = {
  active: boolean;
  phrase: string;
  onComplete: (result: { durationMs: number; attempts: number; power: number }) => void;
  onError: (reason: string) => void;
  trackEvent: (name: string, properties: Record<string, string | number | boolean>) => void;
};

type Status = 'ready' | 'listening' | 'success';

export function YellChallenge({ active, phrase, onComplete, onError, trackEvent }: Props) {
  const [status, setStatus] = useState<Status>('ready');
  const [message, setMessage] = useState('');
  const [attempts, setAttempts] = useState(0);
  const startedAt = useRef(0);
  const finished = useRef(false);
  const attemptsRef = useRef(0);
  const foreground = useRef(AppState.currentState === 'active');
  const callbacks = useRef({ onComplete, onError, trackEvent });

  useEffect(() => {
    callbacks.current = { onComplete, onError, trackEvent };
  }, [onComplete, onError, trackEvent]);

  useEffect(() => {
    if (!active) return undefined;
    let mounted = true;
    foreground.current = AppState.currentState === 'active';
    finished.current = false;
    attemptsRef.current = 0;
    setStatus('ready');
    setMessage('');
    setAttempts(0);
    startedAt.current = Date.now();

    const resultSubscription = addAlarmListener('speechResult', (event) => {
      if (!mounted || !foreground.current || !('recognized' in event) || finished.current) return;
      if (!event.recognized) {
        setStatus('ready');
        setMessage(`We heard “${event.text || 'something'},” not “${phrase}.” Try again.`);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
          .catch((error: unknown) => console.warn('Speech retry haptic failed.', error));
        return;
      }
      finished.current = true;
      setStatus('success');
      setMessage('PHRASE VERIFIED');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        .catch((error: unknown) => console.warn('Speech success haptic failed.', error));
      callbacks.current.trackEvent('challenge_completed', {
        type: 'yell_to_stop',
        phrase,
        attempts: attemptsRef.current,
        duration_ms: Date.now() - startedAt.current,
        confidence: event.confidence,
      });
      setTimeout(() => {
        if (mounted) callbacks.current.onComplete({
          durationMs: Date.now() - startedAt.current,
          attempts: attemptsRef.current,
          power: Math.round(event.confidence * 100),
        });
      }, 500);
    });
    const errorSubscription = addAlarmListener('speechError', (event) => {
      if (!mounted || !foreground.current || !('reason' in event) || finished.current) return;
      setStatus('ready');
      setMessage(event.reason);
      callbacks.current.onError(event.reason);
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      foreground.current = state === 'active';
      if (foreground.current || finished.current) return;
      void stopSpeechRecognition().catch((error: unknown) => {
        console.error('Speech recognition could not be paused in the background.', error);
      });
      setStatus('ready');
      setMessage('Listening paused while Wayykup is in the background. Tap to continue when you return.');
    });

    return () => {
      mounted = false;
      void stopSpeechRecognition().catch((error: unknown) => {
        console.error('Speech recognition could not be stopped.', error);
      });
      resultSubscription.remove();
      errorSubscription.remove();
      appStateSubscription.remove();
    };
  }, [active, phrase]);

  const beginListening = async () => {
    if (!active || !foreground.current || status === 'listening' || finished.current) return;
    setMessage('');
    attemptsRef.current += 1;
    setAttempts(attemptsRef.current);
    setStatus('listening');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setStatus('ready');
        setMessage('Allow microphone access in Settings, then retry.');
        callbacks.current.onError('permission_denied');
        return;
      }
      if (Platform.OS === 'web') throw new Error('On-device speech recognition is unavailable on web.');
      await startSpeechRecognition(phrase);
      callbacks.current.trackEvent('challenge_started', {
        type: 'yell_to_stop',
        phrase,
        attempts: attemptsRef.current,
        duration_ms: Date.now() - startedAt.current,
      });
    } catch (error) {
      console.error('Yell to Stop speech recognition could not start.', error);
      const reason = error instanceof Error ? error.message : 'Speech recognition could not start. Tap to retry.';
      setStatus('ready');
      setMessage(reason);
      callbacks.current.onError(reason);
    }
  };

  return (
    <View style={styles.challengePanel}>
      <Text style={styles.challengeEyebrow}>YELL TO STOP</Text>
      <Text style={styles.challengePrompt}>TIME TO GET LOUD!</Text>
      <Text style={styles.challengeHint}>Say “{phrase}” clearly to stop your alarm.</Text>
      <Animated.View style={[styles.speechPhraseCard, status === 'success' && styles.speechPhraseCardSuccess]}>
        <Text style={styles.speechPhraseText}>{phrase}</Text>
      </Animated.View>
      <View accessibilityRole="progressbar" accessibilityLabel={status === 'listening' ? 'Listening for your phrase' : 'Microphone ready'} style={styles.speechWave}>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((item) => (
          <View
            key={item}
            style={[
              styles.speechWaveBar,
              status === 'listening' && { height: 12 + ((item * 7) % 17) },
              status === 'success' && styles.speechWaveBarSuccess,
            ]}
          />
        ))}
      </View>
      {!!message && <Text style={styles.challengeHint}>{message}</Text>}
      {status !== 'success' && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: status === 'listening' }}
          disabled={status === 'listening'}
          onPress={() => { void beginListening(); }}
          style={[styles.speechButton, status === 'listening' && styles.speechButtonListening]}
        >
          <Text style={styles.speechButtonText}>{status === 'listening' ? 'LISTENING…' : 'TAP TO SPEAK'}</Text>
        </TouchableOpacity>
      )}
      <Text style={styles.challengeHint}>Background noise alone will not count. Your phrase is checked on this device.</Text>
    </View>
  );
}
