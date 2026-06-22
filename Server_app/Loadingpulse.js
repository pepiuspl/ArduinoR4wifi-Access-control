import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

const BLUE = '#004DDD';

/**
 * Ten sam "miękki puls" co na ekranie powitalnym (LoaderAnimation.js), ale
 * zapętlony w kółko - do użycia wszędzie, gdzie aplikacja na coś czeka:
 * sprawdzanie aktualizacji, łączenie z węzłem, zapis ustawień, itd.
 *
 * Używa tych samych dwóch warstw (miękka "aura" + bardziej nasycony środek)
 * animowanych przez transform:scale + opacity - żadnych animowanych
 * promieni SVG, więc działa tak samo pewnie jak na ekranie startowym.
 */
export default function LoadingPulse({ size = 64, color = BLUE }) {
  const scale = useRef(new Animated.Value(0.5)).current;
  const opacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0, duration: 700, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(scale, { toValue: 0.5, duration: 0, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.5, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [scale, opacity]);

  const outerSize = size;
  const innerSize = size * 0.5;

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <View
        style={[
          styles.core,
          { width: innerSize, height: innerSize, borderRadius: innerSize / 2, backgroundColor: color, opacity: 0.85 },
        ]}
      />
      <Animated.View
        style={[
          styles.ring,
          {
            width: outerSize,
            height: outerSize,
            borderRadius: outerSize / 2,
            borderColor: color,
            opacity,
            transform: [{ scale }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  core: { position: 'absolute' },
  ring: { position: 'absolute', borderWidth: 2 },
});