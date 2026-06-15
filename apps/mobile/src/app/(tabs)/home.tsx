import { RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSession } from "../../lib/session";
import { useAsync } from "../../lib/hooks";
import { Screen, Header, Card, Stat, Badge, Button, Loading, Empty, text } from "../../components/ui";
import { C, statusColor, channelName } from "../../lib/theme";
import type { FleetState, ItemSummary } from "../../lib/socheli";

export default function Home() {
  const router = useRouter();
  const { client } = useSession();
  const fleet = useAsync<FleetState>(() => client!.fleet(), []);
  const items = useAsync<ItemSummary[]>(() => client!.items.list({ limit: 8 }), []);
  const reload = () => { fleet.reload(); items.reload(); };
  const loading = fleet.loading || items.loading;

  const published = (items.data ?? []).filter((i) => (i.publish ?? []).some((p) => p.status === "published")).length;
  const spend = (items.data ?? []).reduce((a, i) => a + (i.costUsd ?? 0), 0);

  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.textSecondary} />}>
      <Header eyebrow="// command center" title="War Room" sub="Quality before volume." right={
        <Button title="Generate" variant="primary" onPress={() => router.push("/generate")} style={{ paddingVertical: 9, paddingHorizontal: 14 }} />
      } />

      <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
        <Stat label="Items" value={items.data?.length ?? "—"} foot={`${published} published`} />
        <Stat label="Fleet" value={fleet.data?.online ?? "—"} foot="device(s) online" />
        <Stat label="Spend" value={`$${spend.toFixed(2)}`} foot="recent" />
      </View>

      <Text style={[text.h2, { marginTop: 14 }]}>Fleet</Text>
      {fleet.loading ? <Loading /> : (fleet.data?.devices.length ?? 0) === 0 ? <Empty>No devices connected.</Empty> : (
        <Card>
          {fleet.data!.devices.map((d, i) => (
            <View key={d.device} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 9, borderTopWidth: i ? 1 : 0, borderTopColor: C.border }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, marginRight: 10, backgroundColor: statusColor(d.status) }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.text, fontWeight: "600", fontSize: 14 }}>{d.device}</Text>
                {d.profile && <Text style={text.sub}>{d.profile.ramGb}GB · {d.profile.gpu} · {(d.caps?.length ?? 0)} caps</Text>}
              </View>
              <Badge label={d.status} color={statusColor(d.status)} />
            </View>
          ))}
        </Card>
      )}

      <Text style={[text.h2, { marginTop: 22 }]}>Recent</Text>
      {items.loading ? <Loading /> : (items.data?.length ?? 0) === 0 ? <Empty>No content yet. Tap Generate to make your first post.</Empty> : (
        <View style={{ gap: 10 }}>
          {items.data!.map((it) => (
            <Card key={it.id} onPress={() => router.push(`/item/${it.id}`)}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={{ color: C.text, fontSize: 14, fontWeight: "600" }} numberOfLines={2}>{it.title}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <Badge label={String(it.status).replace(/_/g, " ")} color={statusColor(it.status)} />
                    <Text style={text.sub}>{channelName(it.channel)}</Text>
                  </View>
                </View>
                {it.qa != null && <Text style={{ color: C.accent, fontWeight: "700", fontSize: 15 }}>{it.qa.toFixed(1)}</Text>}
                <Ionicons name="chevron-forward" size={18} color={C.textMuted} style={{ marginLeft: 8 }} />
              </View>
            </Card>
          ))}
        </View>
      )}

      {(fleet.error || items.error) && <Text style={{ color: C.error, marginTop: 16, fontSize: 13 }}>{fleet.error || items.error}</Text>}
    </Screen>
  );
}
