import { useState } from "react";
import { Alert, Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSession } from "../../lib/session";
import { useAsync } from "../../lib/hooks";
import { Screen, Card, Badge, Button, Loading, Empty, text } from "../../components/ui";
import { C, statusColor, channelName } from "../../lib/theme";
import type { Item } from "../../lib/socheli";

function Player({ url }: { url: string }) {
  const player = useVideoPlayer(url, (p) => { p.loop = true; });
  return <VideoView player={player} style={{ width: "100%", aspectRatio: 9 / 16, borderRadius: 14, backgroundColor: "#000", maxHeight: 520, alignSelf: "center" }} contentFit="contain" nativeControls />;
}

export default function ItemDetail() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useSession();
  const { data: it, loading, error, reload } = useAsync<Item>(() => client!.items.get(id), [id]);
  const [publishing, setPublishing] = useState(false);

  const publish = (isPublic: boolean) => {
    Alert.alert(isPublic ? "Publish publicly" : "Publish (private)", "Send this to every configured platform?", [
      { text: "Cancel", style: "cancel" },
      { text: "Publish", onPress: async () => { setPublishing(true); try { await client!.items.publish(id, { public: isPublic }); setTimeout(reload, 2500); } catch (e: any) { Alert.alert("Failed", e?.message ?? "Could not publish"); } setPublishing(false); } },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingTop: insets.top + 8, paddingHorizontal: 14, paddingBottom: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 4 }}><Ionicons name="chevron-back" size={26} color={C.text} /></Pressable>
        <Text style={{ color: C.textSecondary, fontSize: 13, marginLeft: 4 }}>Library</Text>
      </View>

      <Screen edges={false} refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.textSecondary} />}>
        {loading && !it ? <Loading /> : error ? <Empty>{error}</Empty> : !it ? <Empty>Not found.</Empty> : (
          <>
            <Text style={{ color: C.text, fontSize: 21, fontWeight: "800", letterSpacing: -0.4, marginBottom: 10 }}>{it.title}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <Badge label={String(it.status).replace(/_/g, " ")} color={statusColor(it.status)} />
              <Text style={text.sub}>{channelName(it.channel)}</Text>
              {it.qa != null && <Text style={{ color: C.accent, fontWeight: "700" }}>QA {it.qa.toFixed(1)}</Text>}
              {it.costUsd != null && <Text style={text.sub}>· ${it.costUsd.toFixed(3)}</Text>}
            </View>

            {it.videoUrl ? <View style={{ marginBottom: 18 }}><Player url={it.videoUrl} /></View> : <Card style={{ marginBottom: 18, alignItems: "center", paddingVertical: 26 }}><Text style={text.sub}>No render yet — stopped at {it.status}.</Text></Card>}

            {/* render degradations — a quality fallback the pipeline took rather than failing */}
            {(it.warnings ?? []).length > 0 && (
              <Card style={{ marginBottom: 16, borderColor: "rgba(239,176,80,0.34)", backgroundColor: "rgba(239,176,80,0.07)" }}>
                <Text style={{ color: "#efb050", fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginBottom: 8 }}>
                  ⚠ {(it.warnings ?? []).length === 1 ? "1 DEGRADATION" : `${(it.warnings ?? []).length} DEGRADATIONS`} · FINISHED, NOT FULL QUALITY
                </Text>
                {(it.warnings ?? []).map((w, i) => (
                  <View key={`${w.code}-${i}`} style={{ marginBottom: i < (it.warnings ?? []).length - 1 ? 10 : 0 }}>
                    <Text style={{ color: C.text, fontSize: 13 }}>
                      <Text style={{ color: "#efb050", fontWeight: "700", textTransform: "uppercase", fontSize: 11 }}>{w.stage} </Text>
                      {w.message}
                    </Text>
                    {w.detail ? <Text style={{ color: C.textSecondary, fontSize: 11, marginTop: 3 }}>{w.detail}</Text> : null}
                  </View>
                ))}
              </Card>
            )}

            {/* publish */}
            <Card style={{ marginBottom: 16 }}>
              <Text style={text.h2}>Publish</Text>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Button title={publishing ? "…" : "Private"} onPress={() => publish(false)} disabled={publishing} style={{ flex: 1 }} />
                <Button title={publishing ? "…" : "Public"} variant="primary" onPress={() => publish(true)} disabled={publishing} style={{ flex: 1 }} />
              </View>
              {(it.publish ?? []).length > 0 && (
                <View style={{ marginTop: 14, gap: 8 }}>
                  {it.publish!.map((p, i) => (
                    <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ color: C.text, fontWeight: "600", width: 86 }}>{p.platform}</Text>
                      <Badge label={p.status} color={statusColor(p.status)} />
                      {p.url && <Text style={{ color: C.accent, fontSize: 12 }} numberOfLines={1}>{p.status === "published" ? "live" : ""}</Text>}
                    </View>
                  ))}
                </View>
              )}
            </Card>

            {it.storyboard && (
              <Card style={{ marginBottom: 16 }}>
                <Text style={text.h2}>Storyboard · {it.storyboard.scenes.reduce((a, s) => a + s.durationSec, 0)}s</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
                  {it.storyboard.scenes.map((s, i) => (
                    <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: C.border, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 5 }}>
                      <Text style={{ color: C.textMuted, fontSize: 10 }}>{i + 1}</Text>
                      <Text style={{ color: C.textLight, fontSize: 11.5 }}>{s.type}</Text>
                      <Text style={{ color: C.textMuted, fontSize: 10 }}>{s.durationSec}s</Text>
                    </View>
                  ))}
                </View>
              </Card>
            )}

            {it.script && (
              <Card style={{ marginBottom: 16 }}>
                <Text style={text.h2}>Script</Text>
                <Text style={{ color: C.text, fontWeight: "600", marginBottom: 8 }}>{it.script.hook}</Text>
                {it.script.narration.map((n, i) => <Text key={i} style={[text.sub, { marginBottom: 5 }]}>“{n}”</Text>)}
              </Card>
            )}

            {it.pkg && (
              <Card>
                <Text style={text.h2}>Caption</Text>
                <Text style={text.body}>{it.pkg.caption}</Text>
                {it.pkg.hashtags?.length > 0 && <Text style={{ color: C.accentDim, fontSize: 12.5, marginTop: 10 }}>{it.pkg.hashtags.map((h) => `#${h}`).join("  ")}</Text>}
              </Card>
            )}
          </>
        )}
      </Screen>
    </View>
  );
}
