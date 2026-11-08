import React, { useEffect, useState } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export type NavigationTab = 'alarms' | 'stats' | 'settings';

type Props = {
  selected: NavigationTab;
  indicatorPosition: Animated.Value;
  reduceMotion: boolean;
  onSelect: (tab: NavigationTab) => void;
  style?: StyleProp<ViewStyle>;
  scale?: number;
};

const TABS: { id: NavigationTab; icon: string; label: string }[] = [
  { id: 'alarms', icon: '◴', label: 'Alarms' },
  { id: 'stats', icon: '▥', label: 'Stats' },
  { id: 'settings', icon: '⚙', label: 'Settings' },
];

export function GlassNavigationBar({
  selected,
  indicatorPosition,
  reduceMotion,
  onSelect,
  style,
  scale = 1,
}: Props) {
  const [barWidth, setBarWidth] = useState(0);
  const [indicatorScale] = useState(() => new Animated.Value(1));
  const selectedIndex = TABS.findIndex((tab) => tab.id === selected);
  const inset = 4 * scale;
  const tabWidth = Math.max(0, (barWidth - inset * 2) / TABS.length);
  const translateX = indicatorPosition.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [0, tabWidth, tabWidth * 2],
  });

  useEffect(() => {
    if (reduceMotion) {
      indicatorPosition.setValue(selectedIndex);
      indicatorScale.setValue(1);
      return;
    }

    Animated.parallel([
      Animated.spring(indicatorPosition, {
        toValue: selectedIndex,
        damping: 17,
        stiffness: 190,
        mass: 0.75,
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(indicatorScale, {
          toValue: 1.06,
          duration: 100,
          useNativeDriver: true,
        }),
        Animated.spring(indicatorScale, {
          toValue: 1,
          damping: 12,
          stiffness: 220,
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [indicatorPosition, indicatorScale, reduceMotion, selectedIndex]);

  const handleLayout = (event: LayoutChangeEvent) => {
    setBarWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      accessibilityLabel="Main navigation"
      onLayout={handleLayout}
      style={[
        styles.bar,
        {
          minHeight: 60 * scale,
          padding: inset,
        },
        style,
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.glassIndicator,
          {
            left: inset,
            top: inset,
            bottom: inset,
            width: tabWidth,
            transform: [{ translateX }, { scaleX: indicatorScale }],
          },
        ]}
      >
        <View style={styles.glassShine} />
        <View style={styles.glassEdge} />
      </Animated.View>
      <View style={styles.tabs}>
        {TABS.map((tab) => {
          const active = selected === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(tab.id)}
              style={styles.tab}
            >
              <Text
                style={[
                  styles.icon,
                  { fontSize: (active ? 24 : 23) * scale },
                  active ? styles.activeText : styles.inactiveText,
                ]}
              >
                {tab.icon}
              </Text>
              <Text
                style={[
                  styles.label,
                  { fontSize: 11 * scale },
                  active ? styles.activeText : styles.inactiveText,
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    width: '82%',
    maxWidth: 360,
    alignSelf: 'center',
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 36,
    backgroundColor: 'rgba(242, 242, 246, 0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.92)',
    shadowColor: '#555555',
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  glassIndicator: {
    position: 'absolute',
    overflow: 'hidden',
    borderRadius: 32,
    backgroundColor: 'rgba(255, 255, 255, 0.88)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.96)',
    shadowColor: '#D56B6B',
    shadowOpacity: 0.2,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  glassShine: {
    position: 'absolute',
    top: 0,
    left: '12%',
    right: '12%',
    height: '48%',
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.64)',
  },
  glassEdge: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(236, 220, 220, 0.7)',
  },
  tabs: {
    flex: 1,
    flexDirection: 'row',
    alignSelf: 'stretch',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 32,
    gap: 1,
  },
  icon: {
    lineHeight: 26,
  },
  label: {
    fontWeight: '600',
  },
  inactiveText: {
    color: '#77777D',
  },
  activeText: {
    color: '#F31616',
  },
});
