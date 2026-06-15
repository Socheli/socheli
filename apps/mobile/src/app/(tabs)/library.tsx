import { RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSession } from "../../lib/session";
import { useAsync } from "../../lib/hooks";
import { Screen, Header, Card, Badge, Loading, Empty, text } from "../../components/ui";
import { C, statusColor, channelName } from "../../lib/theme";
import type { ItemSummary } from "../../lib/socheli";

export default function Library() {
  const router = useRouter();
  const { client } = useSession();
  const { data, loading, error, reload } = useAsync<ItemSummary[]>(() => client!.items.list({ limit: 60 }), []);

  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.textSecondary} />}>
      <Header eyebrow="// production" title="Library" sub={`${data?.length ?? 0} content items across the lifecycle.`} />
      {loading && !data ? <Loading /> : error ? <Empty>{error}</Empty> : (data?.length ?? 0) === 0 ? <Empty>Queue is empty.</Empty> : (
        <View style={{ gap: 10 }}>
          {data!.map((it) => (
            <Card key={it.id} onPress={() => router.push(`/item/${it.id}`)}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={{ color: C.text, fontSize: 14, fontWeight: "600" }} numberOfLines={2}>{it.title}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    <Badge label={String(it.status).replace(/_/g, " ")} color={statusColor(it.status)} />
                    <Text style={text.sub}>{channelName(it.channel)}</Text>
                    {it.costUsd != null && <Text style={text.sub}>· ${it.costUsd.toFixed(3)}</Text>}
                  </View>
                </View>
                {it.qa != null && <Text style={{ color: C.accent, fontWeight: "700", fontSize: 15, marginRight: 6 }}>{it.qa.toFixed(1)}</Text>}
                <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
              </View>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
