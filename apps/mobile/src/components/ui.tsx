import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle, type TextStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ReactNode } from "react";
import { C } from "../lib/theme";

export function Screen({ children, scroll = true, refreshControl, edges = true }: { children: ReactNode; scroll?: boolean; refreshControl?: ReactNode; edges?: boolean }) {
  const insets = useSafeAreaInsets();
  const pad = { paddingTop: edges ? insets.top + 8 : 8, paddingBottom: insets.bottom + 88 };
  if (!scroll) return <View style={[s.screen, pad]}>{children}</View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={[{ padding: 18 }, pad]} refreshControl={refreshControl as any} showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  );
}

export function Header({ eyebrow, title, sub, right }: { eyebrow?: string; title: string; sub?: string; right?: ReactNode }) {
  return (
    <View style={{ marginBottom: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>
          {eyebrow && <Text style={s.eyebrow}>{eyebrow}</Text>}
          <Text style={s.h1}>{title}</Text>
        </View>
        {right}
      </View>
      {sub && <Text style={[s.sub, { marginTop: 6 }]}>{sub}</Text>}
    </View>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: ViewStyle; onPress?: () => void }) {
  const inner = <View style={[s.card, style]}>{children}</View>;
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>{inner}</Pressable> : inner;
}

export function Stat({ label, value, foot }: { label: string; value: string | number; foot?: string }) {
  return (
    <View style={[s.card, { flex: 1 }]}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
      {foot && <Text style={s.statFoot}>{foot}</Text>}
    </View>
  );
}

export function Badge({ label, color = C.textSecondary }: { label: string; color?: string }) {
  return (
    <View style={[s.badge, { borderColor: color + "66" }]}>
      <View style={[s.dot, { backgroundColor: color }]} />
      <Text style={[s.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function Button({ title, onPress, variant = "default", disabled, style }: { title: string; onPress?: () => void; variant?: "default" | "primary" | "danger"; disabled?: boolean; style?: ViewStyle }) {
  const bg = variant === "primary" ? C.accent : "transparent";
  const fg = variant === "primary" ? "#0a0a0a" : variant === "danger" ? C.error : C.text;
  const bc = variant === "primary" ? C.accent : variant === "danger" ? C.error + "66" : C.borderStrong;
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: bc, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }, style]}>
      <Text style={{ color: fg, fontWeight: "600", fontSize: 14 }}>{title}</Text>
    </Pressable>
  );
}

export function Loading({ label }: { label?: string }) {
  return <View style={{ paddingVertical: 40, alignItems: "center", gap: 12 }}><ActivityIndicator color={C.textSecondary} />{label && <Text style={s.sub}>{label}</Text>}</View>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <View style={[s.card, { alignItems: "center", paddingVertical: 30 }]}><Text style={[s.sub, { textAlign: "center" }]}>{children}</Text></View>;
}

export const text = StyleSheet.create({
  h2: { color: C.text, fontSize: 17, fontWeight: "700", letterSpacing: -0.3, marginBottom: 12 } as TextStyle,
  body: { color: C.textLight, fontSize: 14, lineHeight: 21 } as TextStyle,
  sub: { color: C.textSecondary, fontSize: 13.5 } as TextStyle,
  mono: { color: C.textSecondary, fontSize: 12, fontFamily: undefined } as TextStyle,
});

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  eyebrow: { color: C.textMuted, fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 8 },
  h1: { color: C.text, fontSize: 28, fontWeight: "800", letterSpacing: -0.6 },
  sub: { color: C.textSecondary, fontSize: 13.5, lineHeight: 19 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 16 },
  statLabel: { color: C.textMuted, fontSize: 10.5, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: "600" },
  statValue: { color: C.text, fontSize: 26, fontWeight: "800", letterSpacing: -0.6, marginTop: 8 },
  statFoot: { color: C.textMuted, fontSize: 11.5, marginTop: 6 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, alignSelf: "flex-start" },
  dot: { width: 5, height: 5, borderRadius: 3 },
  badgeText: { fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", fontWeight: "600" },
  btn: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
});
