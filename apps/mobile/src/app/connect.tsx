import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useSession, DEFAULT_API } from "../lib/session";
import { Button } from "../components/ui";
import { C } from "../lib/theme";

export default function Connect() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connect } = useSession();
  const [url, setUrl] = useState(DEFAULT_API);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const go = async () => {
    if (!key.trim()) return;
    setBusy(true); setErr("");
    const r = await connect(url, key);
    setBusy(false);
    if (r.ok) router.replace("/(tabs)/home");
    else setErr(r.error ?? "Could not connect.");
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 26, paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: "center", marginBottom: 34 }}>
          <Image source={require("../../assets/images/splash-icon.png")} style={{ width: 52, height: 52, marginBottom: 16 }} contentFit="contain" />
          <Text style={s.brand}>Socheli</Text>
          <Text style={s.tag}>AGENTIC CONTENT ENGINE</Text>
        </View>

        <View style={s.card}>
          <Text style={s.title}>Connect your workspace</Text>
          <Text style={s.sub}>Sign in with your Socheli API key — find it in the dashboard under Settings → API.</Text>

          <Text style={s.label}>API URL</Text>
          <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder={DEFAULT_API} placeholderTextColor={C.textMuted} style={s.input} />

          <Text style={s.label}>API key</Text>
          <TextInput value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="sk_live_…" placeholderTextColor={C.textMuted} style={s.input} onSubmitEditing={go} />

          {err ? <Text style={s.err}>{err}</Text> : null}
          <Button title={busy ? "Connecting…" : "Connect"} variant="primary" onPress={go} disabled={busy || !key.trim()} style={{ marginTop: 12 }} />
        </View>

        <Text style={s.foot}>RESTRICTED ACCESS · INVITATION ONLY</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  brand: { color: C.text, fontSize: 26, fontWeight: "800", letterSpacing: -0.6 },
  tag: { color: C.textMuted, fontSize: 10.5, letterSpacing: 2, marginTop: 6 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 22 },
  title: { color: C.text, fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  sub: { color: C.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 6, marginBottom: 18 },
  label: { color: C.textSecondary, fontSize: 11.5, fontWeight: "600", marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderStrong, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, color: C.text, fontSize: 14 },
  err: { color: C.error, fontSize: 12.5, marginTop: 12 },
  foot: { color: C.textMuted, fontSize: 10, letterSpacing: 1.5, textAlign: "center", marginTop: 26 },
});
