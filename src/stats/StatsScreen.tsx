import React, { useMemo, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { GlassNavigationBar, type NavigationTab } from '../components/GlassNavigationBar';
import {
  calculateStreaks,
  dayResult,
  deriveInsights,
  derivePeriodMetrics,
  derivePersonalBests,
  formatDuration,
  heatmapDates,
  localDateKey,
  weekDates,
} from './logic';
import { statsTheme as theme } from './theme';
import { alarmSoundName } from '../alarmSounds';
import type { DayResult, Occurrence, StatsPeriod, StreakFreeze } from './types';

type Props = {
  occurrences: Occurrence[];
  freezes: StreakFreeze[];
  now: Date;
  hasAlarms: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSetAlarm: () => void;
  onHome: () => void;
  onSettings: () => void;
  indicatorPosition: Animated.Value;
  reduceMotion: boolean;
  onUseFreeze: (date: string) => Promise<void>;
};

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function dayGroups(occurrences: Occurrence[]) {
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    groups.set(occurrence.localDate, [...(groups.get(occurrence.localDate) ?? []), occurrence]);
  }
  return groups;
}

function resultLabel(result: DayResult): string {
  switch (result) {
    case 'woke': return 'woke on time';
    case 'late': return 'woke late';
    case 'bypassed': return 'bypassed';
    case 'missed': return 'missed';
    case 'frozen': return 'streak protected by freeze';
    case 'pending': return 'alarm not resolved yet';
    case 'rest': return 'rest day';
  }
}

function resultColor(result: DayResult) {
  switch (result) {
    case 'woke': return theme.color.accent;
    case 'late': return theme.color.surface2;
    case 'bypassed': return theme.color.bypass;
    case 'missed': return 'transparent';
    case 'frozen': return theme.color.highlight;
    case 'pending': return theme.color.surface2;
    case 'rest': return 'transparent';
  }
}

function challengeLabel(challenge: Occurrence['challenge']): string {
  switch (challenge) {
    case 'yell_to_stop': return 'Yell to Stop';
    case 'push_up': return 'Push-up Challenge';
    case 'shake_phone': return 'Shake Your Phone';
    case 'object_hunt': return 'Object Hunt';
    case 'legacy': return 'Past challenge';
  }
}

function challengeStatusLabel(status: Occurrence['status']): string {
  switch (status) {
    case 'scheduled': return 'Scheduled';
    case 'ringing': return 'In progress';
    case 'completed': return 'Completed';
    case 'bypassed': return 'Bypassed';
    case 'abandoned': return 'Abandoned';
    case 'missed': return 'Missed';
    case 'skipped': return 'Skipped';
  }
}

function Delta({ children, positive }: { children: string; positive: boolean }) {
  return <Text style={[styles.delta, { color: positive ? theme.color.highlightText : theme.color.muted }]}>{children}</Text>;
}

function StatCard({ title, value, note, delta }: { title: string; value: string; note: string; delta?: { text: string; positive: boolean } | null }) {
  return (
    <View accessible accessibilityLabel={`${title}: ${value}${note ? `, ${note}` : ''}`} style={styles.statCard}>
      <Text style={styles.statLabel}>{title}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {delta ? <Delta positive={delta.positive}>{delta.text}</Delta> : <Text style={styles.statNote}>{note}</Text>}
    </View>
  );
}

function TrendChart({ points, headline, direction }: { points: { localDate: string; valueMs: number }[]; headline: number | null; direction: 'down' | 'up' | null }) {
  const width = 320;
  const height = 172;
  const left = 34;
  const right = 308;
  const top = 14;
  const bottom = 136;
  const maxValue = Math.max(60_000, ...points.map((point) => point.valueMs));
  const roundedMax = Math.ceil(maxValue / 60_000) * 60_000;
  const x = (index: number) => points.length <= 1 ? (left + right) / 2 : left + (right - left) * index / (points.length - 1);
  const y = (value: number) => bottom - (bottom - top) * value / roundedMax;
  const segments: string[] = [];
  let current = '';
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (previous && point.localDate.match(/^\d{4}-\d{2}-\d{2}$/) && previous.localDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const gap = (Date.parse(`${point.localDate}T00:00:00Z`) - Date.parse(`${previous.localDate}T00:00:00Z`)) / 86_400_000;
      if (gap > 1) {
        segments.push(current);
        current = '';
      }
    }
    current += `${current ? ' L' : 'M'} ${x(index)} ${y(point.valueMs)}`;
  });
  if (current) segments.push(current);
  const firstLabel = points[0]?.localDate ?? '';
  const lastLabel = points.at(-1)?.localDate ?? '';
  const headlineText = headline === null
    ? 'More wake-ups needed to show a trend'
    : `${direction === 'down' ? 'Down' : 'Up'} ${Math.abs(headline).toFixed(0)}% in ${points.length > 1 ? points.length - 1 : points.length} days`;

  return (
    <View style={styles.card} accessible accessibilityLabel={`Wake-up trend. ${headlineText}. ${points.length ? `Time to wake ranged from ${formatDuration(Math.min(...points.map((point) => point.valueMs)))} to ${formatDuration(Math.max(...points.map((point) => point.valueMs)))}.` : 'No completed wake-ups yet.'}`}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>30-day trend</Text>
        {!!points.length && <Text style={styles.cardUnit}>TIME TO WAKE</Text>}
      </View>
      <Text style={[styles.trendHeadline, headline !== null && direction === 'up' && styles.trendHeadlineMuted]}>{headlineText}</Text>
      {points.length > 0 ? (
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
          {[0, 0.5, 1].map((fraction) => {
            const lineY = bottom - (bottom - top) * fraction;
            return (
              <React.Fragment key={fraction}>
                <Path d={`M ${left} ${lineY} H ${right}`} stroke={theme.color.divider} strokeWidth={1} />
                <SvgText x={left - 7} y={lineY + 4} fill={theme.color.muted} fontSize={12} textAnchor="end">
                  {formatDuration(roundedMax * fraction)}
                </SvgText>
              </React.Fragment>
            );
          })}
          {segments.filter(Boolean).map((segment, index) => (
            <Path key={`trend-segment-${index}`} d={segment} fill="none" stroke={theme.color.accent} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {points.map((point, index) => (
            <Circle
              key={`${point.localDate}-${index}`}
              cx={x(index)}
              cy={y(point.valueMs)}
              r={index === points.length - 1 ? 5 : 3}
              fill={index === points.length - 1 ? theme.color.highlight : theme.color.accent}
            />
          ))}
          <SvgText x={left} y={height - 8} fill={theme.color.muted} fontSize={12}>{firstLabel.slice(5)}</SvgText>
          <SvgText x={right} y={height - 8} fill={theme.color.muted} fontSize={12} textAnchor="end">{lastLabel.slice(5)}</SvgText>
        </Svg>
      ) : (
        <View style={styles.chartEmpty}><Text style={styles.chartEmptyText}>Complete an alarm challenge to start your trend.</Text></View>
      )}
    </View>
  );
}

export function StatsScreen({
  occurrences,
  freezes,
  now,
  hasAlarms,
  loading,
  error,
  onRetry,
  onSetAlarm,
  onHome,
  onSettings,
  indicatorPosition,
  reduceMotion,
  onUseFreeze,
}: Props) {
  const [period, setPeriod] = useState<StatsPeriod>('month');
  const groups = useMemo(() => dayGroups(occurrences), [occurrences]);
  const usedFreezeDates = useMemo(
    () => new Set(freezes.flatMap((freeze) => freeze.usedLocalDate ? [freeze.usedLocalDate] : [])),
    [freezes],
  );
  const streaks = useMemo(
    () => calculateStreaks(occurrences, usedFreezeDates, now.getTime()),
    [now, occurrences, usedFreezeDates],
  );
  const metrics = useMemo(() => derivePeriodMetrics(occurrences, period, now), [now, occurrences, period]);
  const personalBests = useMemo(() => derivePersonalBests(occurrences, usedFreezeDates), [occurrences, usedFreezeDates]);
  const insights = useMemo(() => deriveInsights(occurrences, now), [now, occurrences]);
  const completedCount = occurrences.filter((item) => item.status === 'completed').length;
  const challengeHistory = useMemo(
    () => occurrences
      .filter((item) => item.status !== 'skipped')
      .slice()
      .sort((a, b) => b.scheduledAt - a.scheduledAt),
    [occurrences],
  );
  const freezeCount = freezes.filter((freeze) => freeze.usedAt === null).length;
  const pendingFreeze = occurrences
    .filter((item) => ['missed', 'bypassed', 'abandoned'].includes(item.status)
      && now.getTime() - item.scheduledAt <= 24 * 60 * 60 * 1000)
    .sort((a, b) => b.scheduledAt - a.scheduledAt)[0];
  const trendEnabled = completedCount >= 3;
  const selectTab = (tab: NavigationTab) => {
    if (tab === 'alarms') onHome();
    if (tab === 'settings') onSettings();
  };
  const tabBar = (
    <GlassNavigationBar
      selected="stats"
      indicatorPosition={indicatorPosition}
      reduceMotion={reduceMotion}
      onSelect={selectTab}
    />
  );

  if (loading) {
    return (
      <View style={styles.page}>
        <View style={styles.loadingPage} accessibilityLabel="Loading your alarm stats">
          <View style={[styles.skeleton, { height: 48 }]} />
          <View style={[styles.skeleton, { height: 190 }]} />
          <View style={styles.skeletonRow}><View style={[styles.skeleton, { flex: 1, height: 130 }]} /><View style={[styles.skeleton, { flex: 1, height: 130 }]} /></View>
          <View style={[styles.skeleton, { height: 170 }]} />
        </View>
        {tabBar}
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.page}>
        <View style={styles.errorPage} accessibilityLabel={`Stats unavailable: ${error}`}>
          <Text style={styles.sectionTitle}>Stats unavailable</Text>
          <Text style={styles.bodyText}>{error}</Text>
          <TouchableOpacity accessibilityRole="button" onPress={onRetry} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>RETRY</Text>
          </TouchableOpacity>
        </View>
        {tabBar}
      </View>
    );
  }

  const dates = weekDates(now);
  const heatDates = heatmapDates(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthLabel = now.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const metricsDelta = metrics.averageDeltaPercent == null ? null : {
    text: `${metrics.averageDeltaPercent > 0 ? '+' : ''}${metrics.averageDeltaPercent.toFixed(0)}% vs previous`,
    positive: metrics.averageDeltaPercent < 0,
  };
  const successDelta = metrics.successRateDelta == null ? null : {
    text: `${metrics.successRateDelta > 0 ? '+' : ''}${Math.round(metrics.successRateDelta * 100)}% vs previous`,
    positive: metrics.successRateDelta > 0,
  };

  return (
    <View style={styles.page}>
      <ScrollView
        style={styles.scrollContent}
        contentContainerStyle={[styles.content, { paddingHorizontal: theme.spacing.screen }]}
        showsVerticalScrollIndicator={false}
      >
      <View style={styles.header}>
        <Text style={styles.pageTitle}>Stats</Text>
        <View style={styles.periodControl} accessibilityLabel="Stats period">
          {(['week', 'month', 'all'] as const).map((value) => (
            <TouchableOpacity
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: period === value }}
              onPress={() => setPeriod(value)}
              style={[styles.periodButton, period === value && styles.periodButtonActive]}
            >
              <Text style={[styles.periodButtonText, period === value && styles.periodButtonTextActive]}>
                {value === 'week' ? 'Week' : value === 'month' ? 'Month' : 'All'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.hero} accessibilityLabel={`Current wake streak ${streaks.current} days, best ${streaks.best} days, ${freezeCount} freezes remaining`}>
        <View style={styles.heroTop}>
          <Text style={styles.heroFlame}>🔥</Text>
          <View style={styles.heroValueGroup}>
            <Text style={styles.heroValue}>{streaks.current}</Text>
            <Text style={styles.heroLabel}>DAY STREAK</Text>
          </View>
          <View style={styles.heroChips}>
            <Text style={styles.heroChip}>Best {streaks.best} days</Text>
            <Text style={styles.heroChip}>{freezeCount} {freezeCount === 1 ? 'freeze' : 'freezes'} left</Text>
          </View>
        </View>
        <View style={styles.weekStrip} accessibilityLabel="This week’s alarm results">
          {dates.map((date, index) => {
            const result = dayResult(groups.get(date) ?? [], usedFreezeDates, now.getTime());
            const today = date === localDateKey(now);
            const future = date > localDateKey(now);
            return (
              <View key={date} style={styles.weekDay}>
                <Text style={styles.weekLabel}>{WEEKDAY_LABELS[index]}</Text>
                <View
                  accessibilityLabel={`${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][index]} ${date}, ${future ? 'upcoming' : resultLabel(result)}`}
                  style={[
                    styles.weekDot,
                    { backgroundColor: future ? theme.color.heroSurface : resultColor(result) },
                    result === 'missed' && styles.weekMissed,
                    result === 'rest' && styles.weekRest,
                    today && styles.weekToday,
                  ]}
                >
                  {result === 'woke' ? <Text style={styles.weekCheck}>✓</Text> : result === 'bypassed' ? <Text style={styles.weekCheck}>/</Text> : result === 'frozen' ? <Text style={styles.weekFrozen}>✦</Text> : null}
                </View>
                <Text style={styles.weekDate}>{Number(date.slice(-2))}</Text>
              </View>
            );
          })}
        </View>
      </View>

      {!hasAlarms && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Start your wake-up record</Text>
          <Text style={styles.bodyText}>Stats are built from alarm rings, never app opens. Set your first alarm to begin.</Text>
          <TouchableOpacity accessibilityRole="button" onPress={onSetAlarm} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>SET YOUR FIRST ALARM</Text>
          </TouchableOpacity>
        </View>
      )}

      {pendingFreeze && freezeCount > 0 && (
        <View style={styles.freezeBanner} accessibilityLabel="A recent alarm is at risk. Spend a streak freeze to protect the streak.">
          <View style={styles.freezeCopy}>
            <Text style={styles.freezeTitle}>Streak at risk?</Text>
            <Text style={styles.bodyText}>Use a freeze on {pendingFreeze.localDate} within 24 hours.</Text>
          </View>
          <TouchableOpacity accessibilityRole="button" onPress={() => { void onUseFreeze(pendingFreeze.localDate); }} style={styles.freezeButton}>
            <Text style={styles.freezeButtonText}>USE FREEZE</Text>
          </TouchableOpacity>
        </View>
      )}

      {(hasAlarms || challengeHistory.length > 0) && (
        <>
          <View style={styles.statGrid} accessibilityLabel="Wake-up averages and success for the selected period">
            <StatCard
              title="AVG TIME TO WAKE"
              value={formatDuration(metrics.averageWakeMs)}
              note="No completed wakes"
              delta={metricsDelta}
            />
            <StatCard
              title="SUCCESS RATE"
              value={metrics.successRate == null ? '—' : `${Math.round(metrics.successRate * 100)}%`}
              note="No resolved alarms"
              delta={successDelta}
            />
            <StatCard
              title="USUAL TIER"
              value={metrics.usualTier ?? '—'}
              note={metrics.previousTier && metrics.previousTier !== metrics.usualTier ? `Was ${metrics.previousTier}` : 'Based on completed wakes'}
            />
          </View>

          {trendEnabled ? (
            <TrendChart points={metrics.trend} headline={metrics.trendPercent} direction={metrics.trendDirection} />
          ) : (
            <View style={styles.unlockCard}>
              <Text style={styles.unlockTitle}>Wake up 3 times to unlock trends</Text>
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.min(100, completedCount / 3 * 100)}%` }]} /></View>
              <Text style={styles.statNote}>{completedCount} of 3 completed wakes</Text>
            </View>
          )}

          <View style={styles.card} accessibilityLabel={`Wake results heatmap for ${monthLabel}`}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Wake map</Text>
              <Text style={styles.cardUnit}>{monthLabel}</Text>
            </View>
            <View style={styles.heatmap}>
              {WEEKDAY_LABELS.map((label, index) => <Text key={`weekday-${label}-${index}`} style={styles.heatmapWeekday}>{label}</Text>)}
              {heatDates.map((date) => {
                const result = dayResult(groups.get(date) ?? [], usedFreezeDates, now.getTime());
                const dateObject = new Date(`${date}T12:00:00`);
                const dateName = dateObject.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
                const outsideMonth = dateObject.getMonth() !== monthStart.getMonth();
                const today = date === localDateKey(now);
                return (
                  <View
                    key={date}
                    accessible
                    accessibilityLabel={`${dateName}, ${resultLabel(result)}`}
                    style={[
                      styles.heatCell,
                      { backgroundColor: resultColor(result), opacity: outsideMonth ? 0.38 : 1 },
                      result === 'missed' && styles.heatMissed,
                      result === 'rest' && styles.heatRest,
                      today && styles.heatToday,
                    ]}
                  >
                    {result === 'woke' ? <Text style={styles.heatMark}>✓</Text> : result === 'bypassed' ? <Text style={styles.heatMark}>/</Text> : result === 'frozen' ? <Text style={styles.heatFrozen}>✦</Text> : <Text style={styles.heatDate}>{Number(date.slice(-2))}</Text>}
                  </View>
                );
              })}
            </View>
            <View style={styles.legend}>
              {[
                ['woke', 'Woke'],
                ['bypassed', 'Bypassed'],
                ['missed', 'Missed'],
                ['rest', 'Rest'],
              ].map(([result, label]) => (
                <View key={result} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: resultColor(result as DayResult) }, result === 'missed' && styles.heatMissed, result === 'rest' && styles.heatRest]} />
                  <Text style={styles.legendText}>{label}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.card} accessibilityLabel="Personal bests">
            <Text style={styles.sectionTitle}>Personal bests</Text>
            <BestRow title="Fastest wake-up" value={formatDuration(personalBests.fastestWake ? (personalBests.fastestWake.completedAt ?? 0) - (personalBests.fastestWake.firstRingAt ?? personalBests.fastestWake.completedAt ?? 0) : null)} />
            <BestRow title="Longest streak" value={`${personalBests.longestStreak} days`} />
            <BestRow title="Hardest sound beaten" value={personalBests.hardestSound ? alarmSoundName(personalBests.hardestSound.soundId) : '—'} detail={personalBests.hardestSound ? `${personalBests.hardestSound.tierReached} · ${personalBests.hardestSound.rearms} re-arms` : undefined} />
          </View>

          <View style={styles.card} accessibilityLabel="Challenge history">
            <Text style={styles.sectionTitle}>Challenge history</Text>
            {challengeHistory.length ? challengeHistory.map((occurrence) => (
              <View key={occurrence.id} style={styles.challengeRow} accessibilityLabel={`${challengeLabel(occurrence.challenge)}, ${challengeStatusLabel(occurrence.status)}, ${new Date(occurrence.scheduledAt).toLocaleString()}`}>
                <View style={styles.challengeCopy}>
                  <Text style={styles.challengeTitle}>{challengeLabel(occurrence.challenge)}</Text>
                  <Text style={styles.statNote}>
                    {new Date(occurrence.scheduledAt).toLocaleString([], {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </Text>
                </View>
                <Text style={[
                  styles.challengeStatus,
                  occurrence.status === 'completed' && styles.challengeStatusCompleted,
                  ['missed', 'bypassed', 'abandoned'].includes(occurrence.status) && styles.challengeStatusUnresolved,
                ]}>
                  {challengeStatusLabel(occurrence.status)}
                </Text>
              </View>
            )) : (
              <Text style={styles.bodyText}>Your scheduled and completed wake-up challenges will appear here.</Text>
            )}
          </View>

          {insights.length > 0 && (
            <View style={styles.card} accessibilityLabel="Personal wake-up insights">
              <Text style={styles.sectionTitle}>Insights</Text>
              {insights.map((insight) => <Text key={insight} style={styles.insight}>{insight}</Text>)}
            </View>
          )}
        </>
      )}
      </ScrollView>
      {tabBar}
    </View>
  );
}

function BestRow({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return (
    <View style={styles.bestRow}>
      <View style={styles.bestCopy}>
        <Text style={styles.bestTitle}>{title}</Text>
        {!!detail && <Text style={styles.statNote}>{detail}</Text>}
      </View>
      <Text style={styles.bestValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  scrollContent: { flex: 1 },
  content: { paddingTop: 40, paddingBottom: 24, gap: theme.spacing.gap },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, minHeight: 48 },
  pageTitle: { color: theme.color.text, fontFamily: theme.font.heading, fontSize: 30, lineHeight: 38 },
  periodControl: { minHeight: 44, flexDirection: 'row', padding: 3, borderRadius: 14, backgroundColor: theme.color.surface2 },
  periodButton: { minWidth: 56, minHeight: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, borderRadius: 11 },
  periodButtonActive: { backgroundColor: theme.color.accent },
  periodButtonText: { color: theme.color.muted, fontFamily: theme.font.medium, fontSize: 13 },
  periodButtonTextActive: { color: theme.color.white, fontFamily: theme.font.strong },
  hero: { padding: 20, borderRadius: theme.radius.card, backgroundColor: theme.color.hero, gap: 18 },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
  heroFlame: { fontSize: 44 },
  heroValueGroup: { minWidth: 96 },
  heroValue: { color: theme.color.heroText, fontFamily: theme.font.number, fontSize: 52, lineHeight: 56 },
  heroLabel: { color: theme.color.accent, fontFamily: theme.font.strong, fontSize: 12, letterSpacing: 1.4 },
  heroChips: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  heroChip: { color: theme.color.heroText, fontFamily: theme.font.medium, fontSize: 12, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 99, backgroundColor: theme.color.heroSurface },
  weekStrip: { flexDirection: 'row', justifyContent: 'space-between', gap: 5 },
  weekDay: { alignItems: 'center', gap: 6 },
  weekLabel: { color: theme.color.heroMuted, fontFamily: theme.font.medium, fontSize: 12 },
  weekDot: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  weekToday: { borderWidth: 2, borderColor: theme.color.highlight },
  weekMissed: { borderWidth: 2, borderColor: theme.color.accent, backgroundColor: 'transparent' },
  weekRest: { borderWidth: 1, borderStyle: 'dashed', borderColor: theme.color.bypass, backgroundColor: 'transparent' },
  weekCheck: { color: theme.color.white, fontFamily: theme.font.strong, fontSize: 14 },
  weekFrozen: { color: theme.color.text, fontFamily: theme.font.strong, fontSize: 14 },
  weekDate: { color: theme.color.heroMuted, fontFamily: theme.font.body, fontSize: 12 },
  card: { padding: 18, borderRadius: theme.radius.card, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.divider, shadowColor: '#3A3038', shadowOpacity: 0.045, shadowRadius: 12, shadowOffset: { width: 0, height: 3 }, elevation: 2, gap: 14 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  sectionTitle: { color: theme.color.text, fontFamily: theme.font.heading, fontSize: 18, lineHeight: 24 },
  cardUnit: { color: theme.color.muted, fontFamily: theme.font.strong, fontSize: 12, letterSpacing: 0.8 },
  bodyText: { color: theme.color.muted, fontFamily: theme.font.body, fontSize: 14, lineHeight: 20 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: { flexGrow: 1, flexBasis: 105, minHeight: 112, padding: 13, borderRadius: 20, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.divider, justifyContent: 'space-between', gap: 7 },
  statLabel: { color: theme.color.muted, fontFamily: theme.font.strong, fontSize: 12, lineHeight: 16, letterSpacing: 0.3 },
  statValue: { color: theme.color.text, fontFamily: theme.font.number, fontSize: 24, lineHeight: 30, textTransform: 'capitalize' },
  statNote: { color: theme.color.muted, fontFamily: theme.font.body, fontSize: 12, lineHeight: 16 },
  delta: { fontFamily: theme.font.strong, fontSize: 12, lineHeight: 16 },
  trendHeadline: { color: theme.color.highlightText, fontFamily: theme.font.strong, fontSize: 14, lineHeight: 19 },
  trendHeadlineMuted: { color: theme.color.muted },
  chartEmpty: { minHeight: 150, justifyContent: 'center', alignItems: 'center' },
  chartEmptyText: { color: theme.color.muted, fontFamily: theme.font.body, fontSize: 14, textAlign: 'center' },
  unlockCard: { padding: 18, borderRadius: theme.radius.card, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.divider, gap: 11 },
  unlockTitle: { color: theme.color.text, fontFamily: theme.font.strong, fontSize: 15 },
  progressTrack: { height: 7, borderRadius: 4, backgroundColor: theme.color.surface2, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: theme.color.accent, borderRadius: 4 },
  heatmap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 7 },
  heatmapWeekday: { width: '13%', textAlign: 'center', color: theme.color.muted, fontFamily: theme.font.strong, fontSize: 12, marginBottom: 2 },
  heatCell: { width: '13%', aspectRatio: 1, borderRadius: theme.radius.cell, alignItems: 'center', justifyContent: 'center' },
  heatMissed: { borderWidth: 2, borderColor: theme.color.accent, backgroundColor: 'transparent' },
  heatRest: { borderWidth: 1, borderStyle: 'dashed', borderColor: theme.color.bypass, backgroundColor: 'transparent' },
  heatToday: { borderWidth: 2, borderColor: theme.color.highlight },
  heatDate: { color: theme.color.muted, fontFamily: theme.font.body, fontSize: 12 },
  heatMark: { color: theme.color.white, fontFamily: theme.font.strong, fontSize: 13 },
  heatFrozen: { color: theme.color.text, fontFamily: theme.font.strong, fontSize: 13 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 12, height: 12, borderRadius: 4 },
  legendText: { color: theme.color.muted, fontFamily: theme.font.body, fontSize: 12 },
  bestRow: { minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.divider, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 8 },
  bestCopy: { flex: 1, gap: 3 },
  bestTitle: { color: theme.color.muted, fontFamily: theme.font.medium, fontSize: 13 },
  bestValue: { color: theme.color.text, fontFamily: theme.font.number, fontSize: 15, textAlign: 'right', textTransform: 'capitalize' },
  challengeRow: { minHeight: 54, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.divider, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 9 },
  challengeCopy: { flex: 1, gap: 3 },
  challengeTitle: { color: theme.color.text, fontFamily: theme.font.strong, fontSize: 14 },
  challengeStatus: { color: theme.color.muted, fontFamily: theme.font.strong, fontSize: 11 },
  challengeStatusCompleted: { color: theme.color.accent },
  challengeStatusUnresolved: { color: theme.color.bypass },
  insight: { color: theme.color.text, fontFamily: theme.font.medium, fontSize: 14, lineHeight: 21, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.divider },
  freezeBanner: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: 16, borderRadius: 16, backgroundColor: theme.color.accentSurface },
  freezeCopy: { flex: 1, minWidth: 160, gap: 3 },
  freezeTitle: { color: theme.color.accent, fontFamily: theme.font.heading, fontSize: 16 },
  freezeButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 13, borderRadius: 12, backgroundColor: theme.color.accent },
  freezeButtonText: { color: theme.color.white, fontFamily: theme.font.strong, fontSize: 12 },
  primaryButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 14, backgroundColor: theme.color.accent, paddingHorizontal: 16, marginTop: 4 },
  primaryButtonText: { color: theme.color.white, fontFamily: theme.font.strong, fontSize: 13, letterSpacing: 0.4 },
  loadingPage: { flex: 1, padding: theme.spacing.screen, paddingTop: 24, backgroundColor: theme.color.background, gap: theme.spacing.gap },
  skeleton: { backgroundColor: theme.color.surface, borderRadius: theme.radius.card },
  skeletonRow: { flexDirection: 'row', gap: 10 },
  errorPage: { flex: 1, justifyContent: 'center', padding: theme.spacing.screen, backgroundColor: theme.color.background, gap: 14 },
});
