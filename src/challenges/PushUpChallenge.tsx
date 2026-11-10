import React, { useEffect, useRef, useState } from 'react';
import { AppState, Text, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { detectPushUpPose } from '../../modules/wayykup-alarm';
import { createPushUpState, updatePushUpState } from './pushUpMachine';
import { styles } from './challengeStyles';

type Props = {
  active: boolean;
  targetCount: 5 | 10 | 15 | 20;
  onComplete: () => void;
  onError: (reason: string) => void;
};

export function PushUpChallenge({ active, targetCount, onComplete, onError }: Props) {
  const camera = useRef<CameraView | null>(null);
  const state = useRef(createPushUpState());
  const completed = useRef(false);
  const callbacks = useRef({ onComplete, onError });
  const [permission, requestPermission] = useCameraPermissions();
  const [count, setCount] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    callbacks.current = { onComplete, onError };
  }, [onComplete, onError]);

  useEffect(() => {
    state.current = createPushUpState();
    completed.current = false;
    setCount(0);
    setMessage('');
  }, [targetCount]);

  useEffect(() => {
    if (!active || !permission?.granted) return undefined;
    let mounted = true;
    let captureInProgress = false;
    let errorReported = false;
    const timer = setInterval(() => {
      if (
        !mounted
        || captureInProgress
        || !cameraReady
        || !camera.current
        || AppState.currentState !== 'active'
        || completed.current
      ) return;
      captureInProgress = true;
      void (async () => {
        try {
          const picture = await camera.current?.takePictureAsync({
            quality: 0.35,
            exif: false,
            shutterSound: false,
          });
          if (!mounted || !picture?.uri) return;
          const pose = await detectPushUpPose(picture.uri);
          if (!mounted) return;
          const next = updatePushUpState(state.current, pose, Date.now());
          state.current = next;
          setCount(next.count);
          if (next.count >= targetCount && !completed.current) {
            completed.current = true;
            setMessage('FORM VERIFIED · REPETITIONS COMPLETE');
            callbacks.current.onComplete();
          } else if (Object.keys(pose).length === 0) {
            setMessage('Step back and keep your full body in view.');
          } else {
            setMessage('Keep your hips aligned and complete a full down-and-up rep.');
          }
        } catch (error) {
          if (mounted && !errorReported) {
            errorReported = true;
            const reason = error instanceof Error ? error.message : 'Camera pose detection is unavailable.';
            setMessage('Pose detection failed. Keep the alarm active and check camera access.');
            callbacks.current.onError(reason);
          }
        } finally {
          captureInProgress = false;
        }
      })();
    }, 500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [active, cameraReady, permission?.granted, targetCount]);

  const allowCamera = async () => {
    try {
      const result = await requestPermission();
      if (!result.granted) setMessage('Camera access is required to verify push-up form.');
    } catch (error) {
      console.error('Push-up camera permission could not be requested.', error);
      setMessage('Camera access could not be requested. Check device Settings.');
    }
  };

  return (
    <View style={styles.challengePanel}>
      <Text style={styles.challengeEyebrow}>PUSH-UP CHALLENGE</Text>
      <Text style={styles.challengePrompt}>SHOW YOUR FORM.</Text>
      <Text style={styles.challengeHint}>
        Position the phone side-on. Keep your shoulders, hips, and ankles visible, then lower your chest and fully extend your arms.
      </Text>
      {permission?.granted ? (
        <View style={{ width: '100%', height: 230, overflow: 'hidden', borderRadius: 12, marginVertical: 12, backgroundColor: '#111111' }}>
          <CameraView
            ref={camera}
            style={{ flex: 1 }}
            facing="back"
            mode="picture"
            onCameraReady={() => setCameraReady(true)}
          />
          <View pointerEvents="none" style={{ position: 'absolute', left: 10, right: 10, top: 10, bottom: 10, borderWidth: 1, borderColor: '#FFFFFF88' }} />
        </View>
      ) : (
        <TouchableOpacity accessibilityRole="button" onPress={() => { void allowCamera(); }} style={styles.speechButton}>
          <Text style={styles.speechButtonText}>ALLOW CAMERA ACCESS</Text>
        </TouchableOpacity>
      )}
      <Text accessibilityRole="progressbar" accessibilityLabel={`${count} of ${targetCount} valid push-ups`} style={styles.speechPhraseText}>
        {String(Math.min(count, targetCount)).padStart(2, '0')} / {targetCount}
      </Text>
      {!!message && <Text accessibilityLiveRegion="polite" style={styles.challengeHint}>{message}</Text>}
      <Text style={styles.challengeHint}>Only a detected lower-and-extend movement with aligned body landmarks counts.</Text>
    </View>
  );
}
