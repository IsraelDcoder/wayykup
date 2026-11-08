import React from 'react';
import { Image, StyleSheet, type ImageStyle, type StyleProp } from 'react-native';

type WayykupIconProps = {
  size?: number;
  style?: StyleProp<ImageStyle>;
};

export function WayykupIcon({ size = 24, style }: WayykupIconProps) {
  return (
    <Image
      accessibilityLabel="Wayykup app icon"
      source={require('../../assets/icon.png')}
      resizeMode="contain"
      style={[styles.icon, { width: size, height: size, borderRadius: size * 0.18 }, style]}
    />
  );
}

const styles = StyleSheet.create({
  icon: {
    overflow: 'hidden',
  },
});
