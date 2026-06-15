import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSession } from "../lib/session";
import { Button, text } from "../components/ui";
import { C, channelName } from "../lib/theme";

const TYPES = [
  { v: "auto", label: "Auto", hint: "select + build + publish" },
  { v: "new", label: "New", hint: "build only" },
  { v: "ping", label: "Ping", hint: "test the fleet" },
];
const CHANNELS = ["concept_lab", "claude_code_lab", "agentic_builder", "moltjobs", "cognitivx"];

function Chip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ borderWidth: 1, borderColor: active ? C.accent : C.borderStrong, backgroundColor: active ? C.accent : "transparent", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}>
      <Text style={{ color: active ? "#0a0a0a" : C.textSecondary, fontWeight: "600", fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export default function Generate() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { client } = useSession();
  const [type, setType] = useState("auto");
  const [channel, setChannel] = useState("concept_lab");
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const dispatch = async () => {
    setBusy(true); setErr(""); setResult(null);
    try {
      const r = await client!.generate({ seed: type === "ping" ? "ping" : seed || "auto", channel, type: type === "ping" ? "new" : (type as any) });
      setResult(`Dispatched ${r.job.id}${r.device ? ` → ${r.device}` : ""}${r.routing ? ` (${r.routing})` : ""}`);
      setSeed("");
    } catch (e: any) {
      setErr(e?.status === 503 ? "No capable device online to take this job." : e?.message ?? "Dispatch failed.");
    }
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingTop: insets.top + 8, paddingHorizontal: 18, paddingBottom: 10 }}>
        <Text style={{ color: C.text, fontSize: 20, fontWeight: "800", letterSpacing: -0.4, flex: 1 }}>Generate</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}><Ionicons name="close" size={24} color={C.textSecondary} /></Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 30 }} keyboardShouldPersistTaps="handled">
        <Text style={[text.sub, { marginBottom: 16 }]}>Dispatch a render job to your device fleet. A capability-matched device picks it up and renders.</Text>

        <Text style={lbl}>Job type</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
          {TYPES.map((t) => <Chip key={t.v} active={type === t.v} label={t.label} onPress={() => setType(t.v)} />)}
        </View>
        <Text style={{ color: C.textMuted, fontSize: 12, marginTop: -12, marginBottom: 18 }}>{TYPES.find((t) => t.v === type)?.hint}</Text>

        {type !== "ping" && (
          <>
            <Text style={lbl}>Channel</Text>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
              {CHANNELS.map((c) => <Chip key={c} active={channel === c} label={channelName(c)} onPress={() => setChannel(c)} />)}
            </View>

            <Text style={lbl}>Idea / seed</Text>
            <TextInput value={seed} onChangeText={setSeed} placeholder="blank = auto-select a concept" placeholderTextColor={C.textMuted} multiline style={{ backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderStrong, borderRadius: 10, padding: 14, color: C.text, fontSize: 14, minHeight: 70, textAlignVertical: "top", marginBottom: 18 }} />
          </>
        )}

        {err ? <Text style={{ color: C.error, marginBottom: 12 }}>{err}</Text> : null}
        {result ? <Text style={{ color: C.success, marginBottom: 12 }}>{result}</Text> : null}

        <Button title={busy ? "Dispatching…" : "Dispatch to fleet"} variant="primary" onPress={dispatch} disabled={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const lbl = { color: C.textSecondary, fontSize: 11.5, fontWeight: "600" as const, marginBottom: 8 };
