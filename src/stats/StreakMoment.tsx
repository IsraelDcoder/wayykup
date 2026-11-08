import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts as useInterFonts,
} from '@expo-google-fonts/inter';
import {
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
  useFonts as useSpaceGroteskFonts,
} from '@expo-google-fonts/space-grotesk';
import { STREAK_MILESTONES } from './constants';
import { formatDuration } from './logic';
import { statsTheme as theme } from './theme';

type Props = {
  streak: number;
  wakeDurationMs: number;
  previousWakeDurationMs: number | null;
  occurrenceId: string;
  rating: 1 | 2 | 3 | 4 | 5 | null;
  reduceMotion: boolean;
  onRate: (rating: 1 | 2 | 3 | 4 | 5) => void;
  onDone: () => void;
};

const CONFETTI_COLORS = [theme.color.accent, theme.color.highlight, '#6DE2B8', '#95A8FF'];

export function StreakMoment({
  streak,
  wakeDurationMs,
  previousWakeDurationMs,
  occurrenceId,
  rating,
  reduceMotion,
  onRate,
  onDone,
}: Props) {
  const [groteskLoaded] = useSpaceGroteskFonts({ SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold });
  const [interLoaded] = useInterFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  const [displayedStreak, setDisplayedStreak] = useState(reduceMotion ? streak : Math.max(0, streak - 1));
  const cardRef = useRef<React.ComponentRef<typeof View> | null>(null);
  const numberValue = useRef(new Animated.Value(reduceMotion ? streak : Math.max(0, streak - 1))).current;
  const flameScale = useRef(new Animated.Value(reduceMotion ? 1 : 0.72)).current;
  const flameOpacity = useRef(new Animated.Value(reduceMotion ? 1 : 0.4)).current;
  const milestone = (STREAK_MILESTONES as readonly number[]).includes(streak);
  const nextMilestone = STREAK_MILESTONES.find((value) => value > streak) ?? 365;
  const priorMilestone = [...STREAK_MILESTONES].reverse().find((value) => value <= streak) ?? 0;
  const progress = (streak - priorMilestone) / Math.max(1, nextMilestone - priorMilestone);

  useEffect(() => {
    if (reduceMotion) return;
    const listener = numberValue.addListener(({ value }) => setDisplayedStreak(Math.round(value)));
    Animated.timing(numberValue, { toValue: streak, duration: 700, useNativeDriver: false }).start();
    Animated.sequence([
      Animated.spring(flameScale, { toValue: 1.18, speed: 20, bounciness: 12, useNativeDriver: true }),
      Animated.spring(flameScale, { toValue: 1, speed: 18, bounciness: 8, useNativeDriver: true }),
    ]).start();
    Animated.sequence([
      Animated.timing(flameOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(flameOpacity, { toValue: 0.82, duration: 180, useNativeDriver: true }),
      Animated.timing(flameOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    });
    return () => numberValue.removeListener(listener);
  }, [flameOpacity, flameScale, numberValue, reduceMotion, streak]);

  const shareStreak = async () => {
    if (!cardRef.current) return;
    try {
      const uri = await captureRef(cardRef.current, { format: 'png', quality: 1, result: 'tmpfile' });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your Wayykup streak' });
      } else {
        await Share.share({ message: `I’ve built a ${streak}-day wake-up streak with Wayykup.` });
      }
    } catch (error) {
      console.error('Streak card could not be shared.', error);
    }
  };

  const comparison = previousWakeDurationMs === null
    ? 'First wake-up recorded. Keep building.'
    : wakeDurationMs <= previousWakeDurationMs
      ? `Up in ${formatDuration(wakeDurationMs)} · ${formatDuration(previousWakeDurationMs - wakeDurationMs)} faster than your last wake`
      : `Up in ${formatDuration(wakeDurationMs)} · ${formatDuration(wakeDurationMs - previousWakeDurationMs)} slower than your last wake`;

  if (!groteskLoaded || !interLoaded) return <View style={styles.loading} />;

  return (
    <View style={styles.page}>
      <View
        ref={cardRef}
        collapsable={false}
        style={styles.shareCard}
        accessibilityLabel={`Streak achieved: ${streak} ${streak === 1 ? 'day' : 'days'}. ${comparison}`}
      >
        {milestone && !reduceMotion && (
          <View pointerEvents="none" style={styles.confetti}>
            {Array.from({ length: 16 }, (_, index) => (
              <View
                key={`confetti-${index}`}
                style={[
                  styles.confettiPiece,
                  {
                    left: `${(index * 37) % 96}%`,
                    top: `${(index * 23) % 36}%`,
                    backgroundColor: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
                    transform: [{ rotate: `${index * 29}deg` }],
                  },
                ]}
              />
            ))}
          </View>
        )}
        <Text style={styles.eyebrow}>PROTOCOL COMPLETE</Text>
        <Animated.Text style={[styles.flame, { opacity: flameOpacity, transform: [{ scale: flameScale }] }]}>🔥</Animated.Text>
        <Text style={styles.number}>{displayedStreak}</Text>
        <Text style={styles.unit}>DAY STREAK</Text>
        {milestone && <Text style={styles.milestone}>{streak}-DAY MILESTONE</Text>}
        <Text style={styles.comparison}>{comparison}</Text>
        <View style={styles.progressGroup}>
          <View style={styles.progressLabels}>
            <Text style={styles.progressText}>{streak} days</Text>
            <Text style={styles.progressText}>Next: {nextMilestone}</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(4, progress * 100))}%` }]} />
          </View>
        </View>
        <Text style={styles.brand}>WAYYKUP</Text>
      </View>

      <View style={styles.ratingSection} accessibilityLabel="Optional morning rating">
        <Text style={styles.ratingTitle}>How did this wake-up feel?</Text>
        <View style={styles.ratingRow}>
          {([1, 2, 3, 4, 5] as const).map((value) => (
            <TouchableOpacity
              key={value}
              accessibilityRole="button"
              accessibilityLabel={`Rate this morning ${value} out of 5`}
              accessibilityState={{ selected: rating === value }}
              onPress={() => onRate(value)}
              style={[styles.ratingButton, rating === value && styles.ratingButtonSelected]}
            >
              <Text style={[styles.ratingText, rating === value && styles.ratingTextSelected]}>{value}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity accessibilityRole="button" onPress={() => { void shareStreak(); }} style={styles.secondaryButton}>
          <Text style={styles.secondaryText}>SHARE STREAK</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={onDone} style={styles.primaryButton}>
          <Text style={styles.primaryText}>DONE</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.occurrence} accessibilityLabel={`Wake record ${occurrenceId}`}>Your wake-up, remembered.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', padding: theme.spacing.screen, backgroundColor: theme.color.background, gap: 20 },
  shareCard: { position: 'relative', overflow: 'hidden', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 26, borderRadius: theme.radius.card, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.divider },
  confetti: { ...StyleSheet.absoluteFill },
  confettiPiece: { position: 'absolute', width: 7, height: 14, borderRadius: 2 },
  eyebrow: { color: theme.color.muted, fontFamily: theme.font.medium, fontSize: 12, letterSpacing: 1.6 },
  flame: { fontSize: 62, marginTop: 16 },
  number: { color: theme.color.text, fontFamily: theme.font.heading, fontSize: 84, lineHeight: 90, marginTop: 2 },
  unit: { color: theme.color.accent, fontFamily: theme.font.strong, fontSize: 14, letterSpacing: 2 },
  milestone: { color: theme.color.highlightText, fontFamily: theme.font.strong, fontSize: 13, letterSpacing: 1, marginTop: 12 },
  comparison: { color: theme.color.text, fontFamily: theme.font.medium, fontSize: 15, lineHeight: 23, textAlign: 'center', marginTop: 18 },
  progressGroup: { width: '100%', marginTop: 23, gap: 9 },
  progressLabels: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  progressText: { color: theme.color.muted, fontFamily: theme.font.medium, fontSize: 12 },
  progressTrack: { height: 8, overflow: 'hidden', borderRadius: 6, backgroundColor: theme.color.surface2 },
  progressFill: { height: '100%', borderRadius: 6, backgroundColor: theme.color.accent },
  brand: { color: theme.color.muted, fontFamily: theme.font.strong, fontSize: 11, letterSpacing: 2, marginTop: 26 },
  ratingSection: { alignItems: 'center', gap: 10 },
  ratingTitle: { color: theme.color.muted, fontFamily: theme.font.medium, fontSize: 13 },
  ratingRow: { flexDirection: 'row', gap: 10 },
  ratingButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, borderWidth: 1, borderColor: theme.color.divider, backgroundColor: theme.color.surface },
  ratingButtonSelected: { borderColor: theme.color.accent, backgroundColor: theme.color.accent },
  ratingText: { color: theme.color.text, fontFamily: theme.font.strong, fontSize: 15 },
  ratingTextSelected: { color: theme.color.white },
  actions: { gap: 10 },
  primaryButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: theme.color.accent },
  primaryText: { color: theme.color.white, fontFamily: theme.font.strong, fontSize: 14, letterSpacing: 0.7 },
  secondaryButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: theme.color.divider },
  secondaryText: { color: theme.color.text, fontFamily: theme.font.strong, fontSize: 13, letterSpacing: 0.5 },
  occurrence: { color: theme.color.muted, fontFamily: theme.font.body, fontSize: 12, textAlign: 'center' },
  loading: { flex: 1, backgroundColor: theme.color.background },
});
